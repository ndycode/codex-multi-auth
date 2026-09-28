//! Port of `lib/audit.ts` — append-only JSONL audit log with size-based
//! rotation (10 MiB / 5 files).
//!
//! Currently **dormant** in the TS repo: `auditLog`/`configureAudit` are not
//! called anywhere and the module is not re-exported by `lib/index.ts`. It is
//! ported for API parity; do not wire it into anything new.
//!
//! The TS module captures the default `logDir` at module load; here the
//! default config is resolved lazily on FIRST access and then frozen (spec 05
//! gotcha 24 explicitly allows either), defaulting to
//! `<multi-auth-dir>/logs` (`getCodexLogDir()`).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use cma_core::json_io::stringify_compact;
use cma_core::logger::{get_correlation_id, mask_email};
use cma_core::runtime_paths::get_codex_log_dir;
use serde_json::{Map, Value};

/// TS `enum AuditAction` — exact string values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AuditAction {
    AccountAdd,
    AccountRemove,
    AccountSwitch,
    AccountRefresh,
    AccountExport,
    AccountImport,
    AuthLogin,
    AuthLogout,
    AuthRefresh,
    AuthFailure,
    ConfigLoad,
    ConfigChange,
    RequestStart,
    RequestSuccess,
    RequestFailure,
    CircuitOpen,
    CircuitClose,
}

impl AuditAction {
    pub const fn as_str(self) -> &'static str {
        match self {
            AuditAction::AccountAdd => "account.add",
            AuditAction::AccountRemove => "account.remove",
            AuditAction::AccountSwitch => "account.switch",
            AuditAction::AccountRefresh => "account.refresh",
            AuditAction::AccountExport => "account.export",
            AuditAction::AccountImport => "account.import",
            AuditAction::AuthLogin => "auth.login",
            AuditAction::AuthLogout => "auth.logout",
            AuditAction::AuthRefresh => "auth.refresh",
            AuditAction::AuthFailure => "auth.failure",
            AuditAction::ConfigLoad => "config.load",
            AuditAction::ConfigChange => "config.change",
            AuditAction::RequestStart => "request.start",
            AuditAction::RequestSuccess => "request.success",
            AuditAction::RequestFailure => "request.failure",
            AuditAction::CircuitOpen => "circuit.open",
            AuditAction::CircuitClose => "circuit.close",
        }
    }
}

/// TS `enum AuditOutcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AuditOutcome {
    Success,
    Failure,
    Partial,
}

impl AuditOutcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            AuditOutcome::Success => "success",
            AuditOutcome::Failure => "failure",
            AuditOutcome::Partial => "partial",
        }
    }
}

/// TS `interface AuditConfig`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditConfig {
    pub enabled: bool,
    pub log_dir: PathBuf,
    pub max_file_size_bytes: u64,
    pub max_files: u32,
}

/// TS `Partial<AuditConfig>` for [`configure_audit`] — shallow merge; only
/// `Some` fields are applied.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuditConfigUpdate {
    pub enabled: Option<bool>,
    pub log_dir: Option<PathBuf>,
    pub max_file_size_bytes: Option<u64>,
    pub max_files: Option<u32>,
}

static AUDIT_CONFIG: Mutex<Option<AuditConfig>> = Mutex::new(None);

/// TS `DEFAULT_CONFIG` — `{ enabled: true, logDir: getCodexLogDir(),
/// maxFileSizeBytes: 10 MiB, maxFiles: 5 }`.
fn default_config() -> AuditConfig {
    AuditConfig {
        enabled: true,
        log_dir: get_codex_log_dir(),
        max_file_size_bytes: 10 * 1024 * 1024,
        max_files: 5,
    }
}

fn with_config<T>(f: impl FnOnce(&mut AuditConfig) -> T) -> T {
    let mut guard = AUDIT_CONFIG
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let config = guard.get_or_insert_with(default_config);
    f(config)
}

/// TS `configureAudit(config)` — shallow merge into the module-level config.
pub fn configure_audit(update: AuditConfigUpdate) {
    with_config(|config| {
        if let Some(enabled) = update.enabled {
            config.enabled = enabled;
        }
        if let Some(log_dir) = update.log_dir {
            config.log_dir = log_dir;
        }
        if let Some(max_file_size_bytes) = update.max_file_size_bytes {
            config.max_file_size_bytes = max_file_size_bytes;
        }
        if let Some(max_files) = update.max_files {
            config.max_files = max_files;
        }
    });
}

/// TS `getAuditConfig()` — returns a copy.
pub fn get_audit_config() -> AuditConfig {
    with_config(|config| config.clone())
}

/// Reset the module-level config so the next access re-resolves defaults.
/// Test-only affordance: the TS module state resets per test-file process;
/// Rust tests share one process.
#[doc(hidden)]
pub fn __reset_audit_config_for_tests() {
    let mut guard = AUDIT_CONFIG
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = None;
}

/// TS `ensureLogDir()` — mkdir recursive, mode 0700 (mode is unix-only; a
/// no-op on Windows, Node parity).
fn ensure_log_dir(log_dir: &Path) -> std::io::Result<()> {
    if !log_dir.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(log_dir)?;
        }
        #[cfg(not(unix))]
        {
            std::fs::create_dir_all(log_dir)?;
        }
    }
    Ok(())
}

fn log_file_path(log_dir: &Path) -> PathBuf {
    log_dir.join("audit.log")
}

/// TS `rotateLogsIfNeeded()` — only when `size >= maxFileSizeBytes`. Loop `i`
/// from `maxFiles - 1` down to `1`: delete the oldest slot on the first
/// iteration, then shift `audit.log → audit.1.log → … → audit.{n-1}.log`.
fn rotate_logs_if_needed(config: &AuditConfig) -> std::io::Result<()> {
    let log_path = log_file_path(&config.log_dir);
    let Ok(metadata) = std::fs::metadata(&log_path) else {
        return Ok(());
    };
    if metadata.len() < config.max_file_size_bytes {
        return Ok(());
    }

    let mut i = config.max_files.saturating_sub(1);
    while i >= 1 {
        let older = config.log_dir.join(format!("audit.{i}.log"));
        let newer = if i == 1 {
            log_path.clone()
        } else {
            config.log_dir.join(format!("audit.{}.log", i - 1))
        };
        if i == config.max_files.saturating_sub(1) && older.exists() {
            std::fs::remove_file(&older)?;
        }
        if newer.exists() {
            std::fs::rename(&newer, &older)?;
        }
        i -= 1;
    }
    Ok(())
}

/// TS `sanitizeActor` — actors containing `@` pass through the LOGGER
/// `maskEmail` variant (not forecast's; spec 05 gotcha 15).
fn sanitize_actor(actor: &str) -> String {
    if actor.contains('@') {
        mask_email(actor)
    } else {
        actor.to_string()
    }
}

/// TS `sanitizeMetadata` (recursive):
/// - key lowercased contains `token`/`secret`/`password` → `"***REDACTED***"`;
/// - string value containing `@` → the WHOLE value through `maskEmail`;
/// - any non-null object → recursed — **including arrays**, which come back
///   as objects keyed `"0"`, `"1"`, … (deliberate TS `Object.entries` quirk;
///   replicated, spec 05 gotcha 19);
/// - everything else passes through (including `null`).
fn sanitize_metadata(metadata: &Map<String, Value>) -> Map<String, Value> {
    let mut sanitized = Map::new();
    for (key, value) in metadata {
        let lower_key = key.to_lowercase();
        if lower_key.contains("token")
            || lower_key.contains("secret")
            || lower_key.contains("password")
        {
            sanitized.insert(key.clone(), Value::String("***REDACTED***".to_string()));
        } else if let Some(text) = value.as_str().filter(|text| text.contains('@')) {
            sanitized.insert(key.clone(), Value::String(mask_email(text)));
        } else if let Some(object) = value.as_object() {
            sanitized.insert(key.clone(), Value::Object(sanitize_metadata(object)));
        } else if let Some(array) = value.as_array() {
            // typeof [] === "object" in JS: arrays are recursed as records.
            let mut as_object = Map::new();
            for (index, item) in array.iter().enumerate() {
                as_object.insert(index.to_string(), item.clone());
            }
            sanitized.insert(key.clone(), Value::Object(sanitize_metadata(&as_object)));
        } else {
            sanitized.insert(key.clone(), value.clone());
        }
    }
    sanitized
}

/// TS `auditLog(action, actor, resource, outcome, metadata?)` — no-op when
/// disabled; **never fails** (all I/O errors swallowed). Appends one compact
/// JSON line (field order: `timestamp`, `correlationId`, `action`, `actor`,
/// `resource`, `outcome`, `metadata?`) to `<logDir>/audit.log`.
pub fn audit_log(
    action: AuditAction,
    actor: &str,
    resource: &str,
    outcome: AuditOutcome,
    metadata: Option<&Map<String, Value>>,
) {
    let config = get_audit_config();
    if !config.enabled {
        return;
    }

    let result: std::io::Result<()> = (|| {
        ensure_log_dir(&config.log_dir)?;
        rotate_logs_if_needed(&config)?;

        let mut entry = Map::new();
        // `new Date().toISOString()` — millisecond precision, `Z` suffix.
        let timestamp = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        entry.insert("timestamp".to_string(), Value::String(timestamp));
        entry.insert(
            "correlationId".to_string(),
            match get_correlation_id() {
                Some(id) => Value::String(id),
                None => Value::Null,
            },
        );
        entry.insert(
            "action".to_string(),
            Value::String(action.as_str().to_string()),
        );
        entry.insert("actor".to_string(), Value::String(sanitize_actor(actor)));
        entry.insert("resource".to_string(), Value::String(resource.to_string()));
        entry.insert(
            "outcome".to_string(),
            Value::String(outcome.as_str().to_string()),
        );
        if let Some(metadata) = metadata {
            entry.insert(
                "metadata".to_string(),
                Value::Object(sanitize_metadata(metadata)),
            );
        }

        let line = format!("{}\n", stringify_compact(&Value::Object(entry)));
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_file_path(&config.log_dir))?;
        file.write_all(line.as_bytes())?;
        Ok(())
    })();
    // Audit logging should never break the application.
    let _ = result;
}

/// TS `getAuditLogPath()`.
pub fn get_audit_log_path() -> PathBuf {
    with_config(|config| log_file_path(&config.log_dir))
}

/// TS `listAuditLogFiles()` — ensures the dir, keeps names matching
/// `audit*.log`, maps to absolute paths, lexicographic sort. (TS propagates
/// fs errors; here an unreadable dir yields an empty list — recorded
/// deviation, the dormant callers never relied on the throw.)
pub fn list_audit_log_files() -> Vec<PathBuf> {
    let log_dir = with_config(|config| config.log_dir.clone());
    let _ = ensure_log_dir(&log_dir);
    let Ok(entries) = std::fs::read_dir(&log_dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with("audit") && name.ends_with(".log"))
        .map(|name| log_dir.join(name))
        .collect();
    files.sort_by(|a, b| a.to_string_lossy().cmp(&b.to_string_lossy()));
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use serial_test::serial;

    fn setup(max_file_size_bytes: u64, max_files: u32) -> tempfile::TempDir {
        __reset_audit_config_for_tests();
        let dir = tempfile::Builder::new()
            .prefix("cma-audit-test-")
            .tempdir()
            .unwrap();
        configure_audit(AuditConfigUpdate {
            enabled: Some(true),
            log_dir: Some(dir.path().to_path_buf()),
            max_file_size_bytes: Some(max_file_size_bytes),
            max_files: Some(max_files),
        });
        dir
    }

    fn read_first_entry() -> Value {
        let content = std::fs::read_to_string(get_audit_log_path()).unwrap();
        serde_json::from_str(content.trim().lines().next().unwrap()).unwrap()
    }

    fn metadata(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    #[serial(audit)]
    fn writes_audit_entry_to_log_file() {
        let _dir = setup(1024, 3);
        audit_log(
            AuditAction::AccountAdd,
            "test-actor",
            "test-resource",
            AuditOutcome::Success,
            None,
        );

        let entry = read_first_entry();
        assert_eq!(entry["action"], "account.add");
        assert_eq!(entry["actor"], "test-actor");
        assert_eq!(entry["resource"], "test-resource");
        assert_eq!(entry["outcome"], "success");
        assert!(entry["timestamp"].is_string());
        assert!(entry.get("correlationId").is_some());
        assert!(entry.get("metadata").is_none());
        // Field order is frozen.
        let keys: Vec<&String> = entry.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            ["timestamp", "correlationId", "action", "actor", "resource", "outcome"]
        );
    }

    #[test]
    #[serial(audit)]
    fn includes_metadata_when_provided() {
        let _dir = setup(1024, 3);
        audit_log(
            AuditAction::AuthLogin,
            "user",
            "auth",
            AuditOutcome::Success,
            Some(&metadata(json!({ "method": "oauth" }))),
        );
        let entry = read_first_entry();
        assert_eq!(entry["metadata"], json!({ "method": "oauth" }));
    }

    #[test]
    #[serial(audit)]
    fn redacts_sensitive_metadata() {
        let _dir = setup(1024, 3);
        audit_log(
            AuditAction::AuthRefresh,
            "user",
            "tokens",
            AuditOutcome::Success,
            Some(&metadata(json!({
                "accessToken": "secret123",
                "refreshToken": "secret456"
            }))),
        );
        let entry = read_first_entry();
        assert_eq!(entry["metadata"]["accessToken"], "***REDACTED***");
        assert_eq!(entry["metadata"]["refreshToken"], "***REDACTED***");
    }

    #[test]
    #[serial(audit)]
    fn masks_email_addresses_in_actor_and_metadata() {
        let _dir = setup(1024, 3);
        audit_log(
            AuditAction::AccountAdd,
            "user@example.com",
            "account",
            AuditOutcome::Success,
            Some(&metadata(json!({ "userEmail": "test@example.org" }))),
        );
        let entry = read_first_entry();
        let actor = entry["actor"].as_str().unwrap();
        assert!(!actor.contains("user@example.com"));
        assert!(actor.contains("***"));
        // Logger maskEmail variant: <=2 local chars + "***@***." + tld.
        assert_eq!(actor, "us***@***.com");
        let email = entry["metadata"]["userEmail"].as_str().unwrap();
        assert!(!email.contains("test@example.org"));
        assert!(email.contains("***"));
    }

    #[test]
    #[serial(audit)]
    fn recursively_sanitizes_nested_object_metadata() {
        let _dir = setup(1024, 3);
        audit_log(
            AuditAction::AccountAdd,
            "actor",
            "account",
            AuditOutcome::Success,
            Some(&metadata(json!({
                "nested": {
                    "secretToken": "hidden-value",
                    "email": "nested@example.com"
                }
            }))),
        );
        let entry = read_first_entry();
        assert_eq!(entry["metadata"]["nested"]["secretToken"], "***REDACTED***");
        assert!(entry["metadata"]["nested"]["email"]
            .as_str()
            .unwrap()
            .contains("***"));
    }

    #[test]
    #[serial(audit)]
    fn arrays_are_recursed_as_records() {
        // TS Object.entries quirk: an array serializes as {"0":..., "1":...}.
        let _dir = setup(1024, 3);
        audit_log(
            AuditAction::AccountAdd,
            "actor",
            "account",
            AuditOutcome::Success,
            Some(&metadata(json!({ "items": ["a@b.com", 7] }))),
        );
        let entry = read_first_entry();
        assert!(entry["metadata"]["items"].is_object());
        assert!(entry["metadata"]["items"]["0"]
            .as_str()
            .unwrap()
            .contains("***"));
        assert_eq!(entry["metadata"]["items"]["1"], 7);
    }

    #[test]
    #[serial(audit)]
    fn does_not_write_when_disabled() {
        let _dir = setup(1024, 3);
        configure_audit(AuditConfigUpdate {
            enabled: Some(false),
            ..Default::default()
        });
        audit_log(
            AuditAction::AccountAdd,
            "actor",
            "resource",
            AuditOutcome::Success,
            None,
        );
        assert!(!get_audit_log_path().exists());
    }

    #[test]
    #[serial(audit)]
    fn configure_preserves_other_config_values() {
        let dir = setup(1024, 3);
        configure_audit(AuditConfigUpdate {
            enabled: Some(false),
            ..Default::default()
        });
        let config = get_audit_config();
        assert!(!config.enabled);
        assert_eq!(config.log_dir, dir.path());
        assert_eq!(config.max_file_size_bytes, 1024);
        assert_eq!(config.max_files, 3);
    }

    #[test]
    #[serial(audit)]
    fn appends_multiple_entries() {
        let _dir = setup(1024 * 1024, 3);
        audit_log(AuditAction::AccountAdd, "a1", "r1", AuditOutcome::Success, None);
        audit_log(
            AuditAction::AccountRemove,
            "a2",
            "r2",
            AuditOutcome::Failure,
            None,
        );
        let content = std::fs::read_to_string(get_audit_log_path()).unwrap();
        assert_eq!(content.trim().lines().count(), 2);
    }

    #[test]
    #[serial(audit)]
    fn rotates_logs_when_max_size_exceeded_and_limits_file_count() {
        let _dir = setup(1024, 3);
        let large = "x".repeat(800);
        for i in 0..10 {
            audit_log(
                AuditAction::RequestStart,
                "actor",
                &format!("resource-{i}"),
                AuditOutcome::Success,
                Some(&metadata(json!({ "data": large }))),
            );
        }
        let files = list_audit_log_files();
        assert!(!files.is_empty());
        // maxFiles: 3 → audit.log + audit.1.log + audit.2.log at most.
        assert!(files.len() <= 3);
    }

    #[test]
    #[serial(audit)]
    fn lists_audit_log_files_sorted() {
        let _dir = setup(1024, 3);
        assert!(list_audit_log_files().is_empty());
        audit_log(
            AuditAction::AccountAdd,
            "actor",
            "resource",
            AuditOutcome::Success,
            None,
        );
        let files = list_audit_log_files();
        assert!(!files.is_empty());
        assert!(files[0].to_string_lossy().contains("audit"));
    }

    #[test]
    fn enum_string_values_are_frozen() {
        assert_eq!(AuditAction::AccountAdd.as_str(), "account.add");
        assert_eq!(AuditAction::AccountRemove.as_str(), "account.remove");
        assert_eq!(AuditAction::AccountSwitch.as_str(), "account.switch");
        assert_eq!(AuditAction::AccountRefresh.as_str(), "account.refresh");
        assert_eq!(AuditAction::AccountExport.as_str(), "account.export");
        assert_eq!(AuditAction::AccountImport.as_str(), "account.import");
        assert_eq!(AuditAction::AuthLogin.as_str(), "auth.login");
        assert_eq!(AuditAction::AuthLogout.as_str(), "auth.logout");
        assert_eq!(AuditAction::AuthRefresh.as_str(), "auth.refresh");
        assert_eq!(AuditAction::AuthFailure.as_str(), "auth.failure");
        assert_eq!(AuditAction::ConfigLoad.as_str(), "config.load");
        assert_eq!(AuditAction::ConfigChange.as_str(), "config.change");
        assert_eq!(AuditAction::RequestStart.as_str(), "request.start");
        assert_eq!(AuditAction::RequestSuccess.as_str(), "request.success");
        assert_eq!(AuditAction::RequestFailure.as_str(), "request.failure");
        assert_eq!(AuditAction::CircuitOpen.as_str(), "circuit.open");
        assert_eq!(AuditAction::CircuitClose.as_str(), "circuit.close");
        assert_eq!(AuditOutcome::Success.as_str(), "success");
        assert_eq!(AuditOutcome::Failure.as_str(), "failure");
        assert_eq!(AuditOutcome::Partial.as_str(), "partial");
    }
}
