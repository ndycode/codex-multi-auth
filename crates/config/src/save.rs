//! Port of the save half of `lib/config.ts` — `savePluginConfig` (spec 01
//! §4.3, verbatim algorithm).
//!
//! 1. Sanitize the patch per-field; dropped keys → warn-once
//!    `Ignoring invalid plugin config field(s): <keys>.`
//! 2. Env-path branch (`CODEX_MULTI_AUTH_CONFIG_PATH` set, even if the file
//!    does not exist yet — gotcha 1): per-path in-process queue → cross-process
//!    lockfile → 3-try ESTALE mtime-CAS around stat → classify-read → merge
//!    (unknown keys PRESERVED) → atomic write.
//! 3. Unified branch: in-process queue on the unified path → classify-read of
//!    settings.json → `pluginConfig` section (or sync loader fallback) →
//!    legacy-file fallback when the section is absent → merge →
//!    `save_unified_plugin_config` (which replaces the whole section while
//!    preserving sibling sections).
//!
//! `status == "unreadable"` anywhere aborts with the frozen `StorageError`
//! (`"Aborting config save because <path> is unreadable."`, code
//! `"UNREADABLE"`, hint `"Fix or remove the unreadable config file, then
//! retry the save."`). `invalid`/`missing` rebuild from the patch (gotcha 12).

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use serde_json::{Map, Value};
use tokio::sync::Mutex as AsyncMutex;

use cma_core::errors::CodexError;
use cma_core::fs_retry::{
    Backoff, HasErrorCode, RetryOptions, code_of, io_error_with_code, with_retry,
};
use cma_core::json_io::{file_mtime_ms, stringify_pretty2};
use cma_core::schemas::plugin_config::{PLUGIN_CONFIG_KEYS, PluginConfig};
use cma_core::temp_path::temp_path_for;

use crate::load::{
    ConfigReadState, RETRYABLE_CONFIG_READ_CODES, RETRYABLE_FS_CODES, env_config_path,
    log_config_warn_once, read_config_record_for_save, resolve_plugin_config_path,
    sanitize_plugin_config_record, sanitize_stored_plugin_config_record,
};
use crate::lockfile::with_config_file_lock;
use crate::unified_settings::{get_unified_settings_path, load_unified_plugin_config_sync,
    save_unified_plugin_config};

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Failure of [`save_plugin_config`]: either the typed `StorageError`
/// (`code() == "UNREADABLE"`) or an IO failure (whose Node-style code —
/// `"ELOCKTIMEOUT"`, `"ESTALE"`, errno strings — is recoverable through
/// [`HasErrorCode`]).
#[derive(Debug)]
pub enum ConfigSaveError {
    Storage(CodexError),
    Io(io::Error),
}

impl fmt::Display for ConfigSaveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigSaveError::Storage(error) => write!(f, "{}", error.message()),
            ConfigSaveError::Io(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for ConfigSaveError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ConfigSaveError::Storage(error) => Some(error),
            ConfigSaveError::Io(error) => Some(error),
        }
    }
}

impl From<io::Error> for ConfigSaveError {
    fn from(error: io::Error) -> Self {
        ConfigSaveError::Io(error)
    }
}

impl HasErrorCode for ConfigSaveError {
    fn error_code(&self) -> Option<&str> {
        match self {
            ConfigSaveError::Storage(error) => Some(error.code()),
            ConfigSaveError::Io(error) => code_of(error),
        }
    }
}

impl ConfigSaveError {
    /// The typed `StorageError` when this failure was an unreadable-abort.
    pub fn as_storage(&self) -> Option<&CodexError> {
        match self {
            ConfigSaveError::Storage(error) => Some(error),
            ConfigSaveError::Io(_) => None,
        }
    }
}

/// `unreadableConfigSaveError` — frozen message/hint (spec 01 §8).
fn unreadable_config_save_error(config_path: &Path, error_message: &str) -> CodexError {
    CodexError::storage(
        format!(
            "Aborting config save because {} is unreadable.",
            config_path.display()
        ),
        "UNREADABLE",
        config_path.display().to_string(),
        "Fix or remove the unreadable config file, then retry the save.",
        Some(Box::new(io::Error::other(error_message.to_string()))),
    )
}

// ---------------------------------------------------------------------------
// In-process per-path save queue (TS `configSaveQueues`)
// ---------------------------------------------------------------------------

static CONFIG_SAVE_QUEUES: LazyLock<StdMutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

/// `withConfigSaveLock` — FIFO per-path serialization; the map entry is
/// removed when the last queued task finishes (predecessor failures never
/// block successors — the tokio Mutex releases on drop regardless).
async fn with_config_save_lock<T, F, Fut>(path: &Path, task: F) -> T
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = T>,
{
    let mutex = {
        let mut queues = CONFIG_SAVE_QUEUES.lock().unwrap_or_else(|p| p.into_inner());
        Arc::clone(
            queues
                .entry(path.to_path_buf())
                .or_insert_with(|| Arc::new(AsyncMutex::new(()))),
        )
    };
    let result = {
        let _guard = mutex.lock().await;
        task().await
    };
    {
        let mut queues = CONFIG_SAVE_QUEUES.lock().unwrap_or_else(|p| p.into_inner());
        // 2 == the map's reference + ours: nobody else is queued on this path.
        if Arc::strong_count(&mutex) == 2 {
            queues.remove(path);
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Patch sanitization
// ---------------------------------------------------------------------------

/// `sanitizePluginConfigForSave` — per-field validation (known keys only;
/// unknown patch keys are silently dropped), plus the dropped-keys list for
/// the warn-once. Non-finite numbers cannot occur in JSON input; nested
/// records are cloned (shallow-copy parity).
pub(crate) fn sanitize_plugin_config_for_save(
    config_patch: &Map<String, Value>,
) -> (Map<String, Value>, Vec<&'static str>) {
    let normalized =
        sanitize_plugin_config_record(&Value::Object(config_patch.clone()), false)
            .unwrap_or_default();
    let dropped_keys: Vec<&'static str> = PLUGIN_CONFIG_KEYS
        .iter()
        .copied()
        .filter(|key| config_patch.contains_key(*key) && !normalized.contains_key(*key))
        .collect();
    (normalized, dropped_keys)
}

// ---------------------------------------------------------------------------
// Env-path write plumbing
// ---------------------------------------------------------------------------

/// `getConfigFileMtimeMs` — retried stat (5 attempts, 10/20/40/80 ms,
/// EBUSY/EPERM/EAGAIN; config-08). ENOENT → `None` immediately.
async fn get_config_file_mtime_ms(file_path: &Path) -> io::Result<Option<f64>> {
    with_retry(
        || {
            let file_path = file_path.to_path_buf();
            async move { file_mtime_ms(&file_path) }
        },
        RetryOptions::<io::Error>::new(
            5,
            Backoff::from_fn(|attempt| {
                10u64.saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1)))
            }),
        )
        .with_codes(RETRYABLE_CONFIG_READ_CODES),
    )
    .await
}

/// `writeJsonFileAtomicWithRetry` — temp stage (`tempPathFor`), mkdir -p,
/// `JSON.stringify(payload, null, 2)` + `"\n"`, mtime CAS via the RETRIED
/// stat (mismatch → `"ESTALE"` with the frozen config message), rename with
/// EBUSY/EPERM ×5 (10/20/40/80 ms), best-effort temp unlink on failure.
async fn write_json_file_atomic_with_retry(
    file_path: &Path,
    payload: &Map<String, Value>,
    expected_mtime_ms: Option<f64>,
) -> io::Result<()> {
    let temp_path = temp_path_for(file_path);
    if let Some(parent) = file_path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)?;
    }
    let data = format!("{}\n", stringify_pretty2(&Value::Object(payload.clone())));
    fs::write(&temp_path, &data)?;

    let outcome: io::Result<()> = async {
        // Compare-and-swap guard: if a concurrent writer changed the target
        // since the caller read it, abort with ESTALE so the caller re-reads
        // and merges instead of clobbering the other write.
        let current_mtime_ms = get_config_file_mtime_ms(file_path).await?;
        if current_mtime_ms != expected_mtime_ms {
            return Err(io_error_with_code(
                "ESTALE",
                format!(
                    "Config at {} changed on disk during save; retrying with latest state.",
                    file_path.display()
                ),
            ));
        }
        with_retry(
            || {
                let temp_path = temp_path.clone();
                let file_path = file_path.to_path_buf();
                async move { fs::rename(&temp_path, &file_path) }
            },
            RetryOptions::<io::Error>::new(
                5,
                Backoff::from_fn(|attempt| {
                    10u64.saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1)))
                }),
            )
            .with_codes(RETRYABLE_FS_CODES),
        )
        .await
    }
    .await;

    if outcome.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    outcome
}

// ---------------------------------------------------------------------------
// savePluginConfig
// ---------------------------------------------------------------------------

/// JS spread merge `{...existing, ...patch}` over order-preserving maps.
fn merge_records(
    existing: Option<&Map<String, Value>>,
    patch: &Map<String, Value>,
) -> Map<String, Value> {
    let mut merged = existing.cloned().unwrap_or_default();
    for (key, value) in patch {
        merged.insert(key.clone(), value.clone());
    }
    merged
}

/// `savePluginConfig(configPatch)` — the full §4.3 algorithm. The patch is a
/// raw JSON record so invalid values can be observed and dropped exactly like
/// the TS `Partial<PluginConfig>` path; use [`save_plugin_config_typed`] for
/// an already-typed patch.
pub async fn save_plugin_config(config_patch: &Map<String, Value>) -> Result<(), ConfigSaveError> {
    let (sanitized_patch, dropped_keys) = sanitize_plugin_config_for_save(config_patch);
    if !dropped_keys.is_empty() {
        log_config_warn_once(&format!(
            "Ignoring invalid plugin config field(s): {}.",
            dropped_keys.join(", ")
        ));
    }

    if let Some(env_path) = env_config_path() {
        let env_path = PathBuf::from(env_path);
        return with_config_save_lock(&env_path, || async {
            // In-process queue is the cheap fast path; the cross-process file
            // lock closes the read→merge→rename TOCTOU window against OTHER
            // processes; the mtime CAS stays as a second-line guard.
            with_config_file_lock(&env_path, || async {
                with_retry(
                    || async {
                        let expected_mtime_ms = get_config_file_mtime_ms(&env_path).await?;
                        let env_config_state = read_config_record_for_save(&env_path).await;
                        let existing_config = match env_config_state {
                            ConfigReadState::Unreadable { error_message } => {
                                return Err(ConfigSaveError::Storage(
                                    unreadable_config_save_error(&env_path, &error_message),
                                ));
                            }
                            ConfigReadState::Ok(record) => {
                                sanitize_stored_plugin_config_record(&Value::Object(record))
                            }
                            ConfigReadState::Invalid { .. } | ConfigReadState::Missing => None,
                        };
                        let merged = merge_records(existing_config.as_ref(), &sanitized_patch);
                        write_json_file_atomic_with_retry(&env_path, &merged, expected_mtime_ms)
                            .await?;
                        Ok(())
                    },
                    RetryOptions::<ConfigSaveError>::fixed(3, 0).with_codes(&["ESTALE"]),
                )
                .await
            })
            .await
        })
        .await;
    }

    let unified_path = get_unified_settings_path();
    with_config_save_lock(&unified_path, || async {
        let unified_config_state = read_config_record_for_save(&unified_path).await;
        let unified_config_record: Value = match &unified_config_state {
            ConfigReadState::Unreadable { error_message } => {
                return Err(ConfigSaveError::Storage(unreadable_config_save_error(
                    &unified_path,
                    error_message,
                )));
            }
            ConfigReadState::Ok(record) => {
                record.get("pluginConfig").cloned().unwrap_or(Value::Null)
            }
            _ => match load_unified_plugin_config_sync() {
                Some(section) => Value::Object(section),
                None => Value::Null,
            },
        };
        let unified_config = sanitize_stored_plugin_config_record(&unified_config_record);
        let legacy_path = if unified_config.is_none() {
            resolve_plugin_config_path(&crate::load::ConfigPaths::resolve())
        } else {
            None
        };
        let legacy_config = match &legacy_path {
            Some(path) => match read_config_record_for_save(path).await {
                ConfigReadState::Unreadable { error_message } => {
                    return Err(ConfigSaveError::Storage(unreadable_config_save_error(
                        path,
                        &error_message,
                    )));
                }
                ConfigReadState::Ok(record) => {
                    sanitize_stored_plugin_config_record(&Value::Object(record))
                }
                _ => None,
            },
            None => None,
        };
        let base = unified_config.or(legacy_config);
        let merged = merge_records(base.as_ref(), &sanitized_patch);
        save_unified_plugin_config(&merged)
            .await
            .map_err(ConfigSaveError::Io)
    })
    .await
}

/// Convenience wrapper: serialize a typed partial [`PluginConfig`] (only its
/// `Some` fields) and delegate to [`save_plugin_config`].
pub async fn save_plugin_config_typed(patch: &PluginConfig) -> Result<(), ConfigSaveError> {
    let value = serde_json::to_value(patch).unwrap_or_else(|_| Value::Object(Map::new()));
    let map = match value {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    save_plugin_config(&map).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitize_for_save_drops_invalid_known_keys_and_reports_them() {
        let patch: Map<String, Value> = serde_json::from_value(json!({
            "codexMode": true,
            "toastDurationMs": 10,        // below min 1000 → dropped + reported
            "codexTuiGlyphMode": "wrong", // invalid enum → dropped + reported
            "someUnknown": 1,             // unknown → silently dropped, NOT reported
        }))
        .unwrap();
        let (sanitized, dropped) = sanitize_plugin_config_for_save(&patch);
        assert_eq!(sanitized.get("codexMode"), Some(&json!(true)));
        assert!(!sanitized.contains_key("toastDurationMs"));
        assert!(!sanitized.contains_key("someUnknown"));
        assert_eq!(dropped, vec!["codexTuiGlyphMode", "toastDurationMs"]);
    }

    #[test]
    fn dropped_keys_follow_schema_declaration_order() {
        let patch: Map<String, Value> = serde_json::from_value(json!({
            "schedulingStrategy": "nope",
            "codexMode": "not-a-bool",
        }))
        .unwrap();
        let (_, dropped) = sanitize_plugin_config_for_save(&patch);
        // PLUGIN_CONFIG_KEYS order, not input order.
        assert_eq!(dropped, vec!["codexMode", "schedulingStrategy"]);
    }

    #[test]
    fn merge_overlays_patch_and_preserves_existing_key_positions() {
        let existing: Map<String, Value> =
            serde_json::from_str(r#"{"futureKey":1,"codexMode":true,"other":2}"#).unwrap();
        let patch: Map<String, Value> =
            serde_json::from_str(r#"{"codexMode":false,"fastSession":true}"#).unwrap();
        let merged = merge_records(Some(&existing), &patch);
        let keys: Vec<&str> = merged.keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["futureKey", "codexMode", "other", "fastSession"]);
        assert_eq!(merged.get("codexMode"), Some(&json!(false)));
    }

    #[test]
    fn unreadable_error_carries_frozen_message_code_path_and_hint() {
        let error = unreadable_config_save_error(Path::new("/tmp/config.json"), "boom");
        assert_eq!(error.code(), "UNREADABLE");
        assert!(
            error
                .message()
                .starts_with("Aborting config save because "),
            "message: {}",
            error.message()
        );
        assert!(error.message().ends_with(" is unreadable."));
        assert_eq!(
            error.hint(),
            Some("Fix or remove the unreadable config file, then retry the save.")
        );
        assert!(error.path().is_some());
    }

    #[tokio::test]
    async fn write_json_file_atomic_cas_mismatch_yields_estale() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("config.json");
        fs::write(&target, "{}").unwrap();
        let payload: Map<String, Value> = Map::new();
        // Expect "missing" while the file exists → ESTALE.
        let error = write_json_file_atomic_with_retry(&target, &payload, None)
            .await
            .unwrap_err();
        assert_eq!(code_of(&error), Some("ESTALE"));
        assert!(error.to_string().contains("changed on disk during save"));
        // Temp cleaned up.
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }
}
