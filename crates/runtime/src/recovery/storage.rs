//! Port of `lib/recovery/storage.ts` — synchronous readers, corruption
//! quarantine, and surgical repairs over the host runtime's session store
//! (spec 11 §6.3).
//!
//! Key contracts (spec 11 §12 gotchas 28–31):
//! - transient read errors (EBUSY/EPERM/EACCES/EAGAIN/ENOENT) are races, not
//!   corruption: skip, never quarantine;
//! - successful read + bad JSON/shape ⇒ quarantine rename `.corrupt-{ts}`;
//!   the count increments even when the rename fails;
//! - `SAFE_ID_PATTERN` gates every id before a path join (traversal defense);
//!   readers propagate the error, repair fns catch and return `false`;
//! - synthetic thinking ids sort before every real part id and are unique
//!   per invocation (RPTU-001);
//! - `strip_thinking_parts` only reports success when every targeted part
//!   was removed (recovery-05).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use cma_core::fs_retry::{Backoff, RetryOptions, with_retry_sync};
use cma_core::temp_path::temp_file_nonce;
use cma_core::utils::now_ms;
use rand::RngCore;
use serde_json::Value;

use super::constants::{is_meta_type, is_thinking_type, message_storage, part_storage};
use super::types::{StoredMessageMeta, StoredPart};

// =============================================================================
// Corruption quarantine (recovery-10)
// =============================================================================

static CORRUPTION_STATS: Mutex<(u64, Vec<String>)> = Mutex::new((0, Vec::new()));

/// Transient read-side faults that are NOT corruption (spec 11 §6.3).
const TRANSIENT_READ_CODES: [&str; 5] = ["EBUSY", "EPERM", "EACCES", "EAGAIN", "ENOENT"];

/// Retry codes for rename/unlink (matches `lib/storage.ts` convention).
const RETRYABLE_FS_CODES: [&str; 4] = ["EBUSY", "EPERM", "ENOTEMPTY", "EAGAIN"];

/// Snapshot of corrupt-file quarantine activity for this process.
pub fn get_recovery_corruption_stats() -> (u64, Vec<String>) {
    let stats = CORRUPTION_STATS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    (stats.0, stats.1.clone())
}

/// Test-only reset of the corruption counters (TS
/// `__resetRecoveryCorruptionStats`).
pub fn __reset_recovery_corruption_stats() {
    let mut stats = CORRUPTION_STATS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    stats.0 = 0;
    stats.1.clear();
}

fn log() -> cma_core::logger::ScopedLogger {
    cma_core::logger::create_logger("recovery-storage")
}

fn is_transient_read_error(error: &io::Error) -> bool {
    match cma_core::fs_retry::code_of(error) {
        Some(code) => TRANSIENT_READ_CODES.contains(&code),
        None => false,
    }
}

/// Read-failure classification: transient errors skip, everything else
/// quarantines (spec 11 gotcha 28).
enum ReadFailure {
    /// Transient FS race (or genuine corruption pre-classified).
    TransientIo(io::Error),
    /// Successful read, but the payload failed parse/shape validation.
    Corrupt(String),
}

fn handle_unreadable_file(file_path: &Path, failure: ReadFailure) {
    match failure {
        ReadFailure::TransientIo(error) if is_transient_read_error(&error) => {
            log().debug(
                "skipping recovery file on transient read error",
                Some(&serde_json::json!({
                    "path": file_path.display().to_string(),
                    "reason": error.to_string(),
                })),
            );
        }
        ReadFailure::TransientIo(error) => {
            quarantine_corrupt_file(file_path, &error.to_string());
        }
        ReadFailure::Corrupt(reason) => {
            quarantine_corrupt_file(file_path, &reason);
        }
    }
}

fn quarantine_corrupt_file(file_path: &Path, reason: &str) {
    {
        let mut stats = CORRUPTION_STATS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        stats.0 += 1;
    }
    let target = PathBuf::from(format!("{}.corrupt-{}", file_path.display(), now_ms()));
    match rename_sync_with_retry(file_path, &target) {
        Ok(()) => {
            let mut stats = CORRUPTION_STATS
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            stats.1.push(target.display().to_string());
            drop(stats);
            log().warn(
                "quarantined corrupt recovery file",
                Some(&serde_json::json!({
                    "path": target.display().to_string(),
                    "reason": reason,
                })),
            );
        }
        Err(rename_error) => {
            log().warn(
                "failed to quarantine corrupt recovery file",
                Some(&serde_json::json!({
                    "path": file_path.display().to_string(),
                    "reason": reason,
                    "renameError": rename_error.to_string(),
                })),
            );
        }
    }
}

// =============================================================================
// ID safety (recovery-02/03)
// =============================================================================

/// TS `SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/`.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// TS `validatePathId(id, name)` — errors with the exact frozen message.
/// Readers propagate this error; repair fns catch it and return `false`.
pub fn validate_path_id(id: &str, name: &str) -> Result<(), String> {
    if !is_safe_id(id) {
        return Err(format!("Invalid {name}: contains unsafe characters"));
    }
    Ok(())
}

// =============================================================================
// Record validation (recovery-02)
// =============================================================================

fn is_valid_stored_message(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    let Some(id) = obj.get("id").and_then(Value::as_str) else {
        return false;
    };
    if !is_safe_id(id) {
        return false;
    }
    if let Some(time) = obj.get("time") {
        let Some(time_obj) = time.as_object() else {
            return false;
        };
        if let Some(created) = time_obj.get("created") {
            match created.as_f64() {
                Some(v) if v.is_finite() => {}
                _ => return false,
            }
        }
    }
    true
}

fn is_valid_stored_part(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    let id_ok = obj
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(is_safe_id);
    id_ok && obj.get("type").is_some_and(Value::is_string)
}

// =============================================================================
// FS helpers
// =============================================================================

fn rename_sync_with_retry(source: &Path, target: &Path) -> io::Result<()> {
    with_retry_sync(
        || fs::rename(source, target),
        RetryOptions::new(4, Backoff::from_fn(|attempt| 10 * 2u64.pow(attempt - 1)))
            .with_codes(&RETRYABLE_FS_CODES),
    )
}

/// Atomic write: temp sibling `{path}.tmp.{nonce}` + rename-with-retry; the
/// staged file is unlinked on failure.
fn atomic_write_file_sync(path: &Path, data: &str) -> io::Result<()> {
    let temp_path = PathBuf::from(format!("{}.tmp.{}", path.display(), temp_file_nonce()));
    let result = (|| -> io::Result<()> {
        fs::write(&temp_path, data)?;
        set_file_mode_0600(&temp_path);
        rename_sync_with_retry(&temp_path, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(unix)]
fn set_file_mode_0600(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_file_mode_0600(_path: &Path) {}

/// Best-effort delete with bounded retry. Returns `true` on removal, `false`
/// on missing file or exhausted retries; never errors.
fn safe_unlink_with_retry(file_path: &Path, max_attempts: u32) -> bool {
    with_retry_sync(
        || fs::remove_file(file_path),
        RetryOptions::new(
            max_attempts,
            Backoff::from_fn(|attempt| 2u64.pow(attempt - 1) * 5),
        )
        .with_codes(&RETRYABLE_FS_CODES),
    )
    .is_ok()
}

// =============================================================================
// ID generation
// =============================================================================

/// TS `generatePartId()` — `prt_{hex ms}{8 hex random}`.
pub fn generate_part_id() -> String {
    let timestamp = format!("{:x}", now_ms());
    let mut bytes = [0u8; 4];
    rand::rng().fill_bytes(&mut bytes);
    let random: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("prt_{timestamp}{random}")
}

static THINKING_PART_COUNTER: AtomicU64 = AtomicU64::new(0);

fn to_base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("base36 digits are ASCII")
}

/// TS `generateThinkingPartId()` — unique per invocation (RPTU-001) and
/// lexicographically BEFORE every [`generate_part_id`] output (the
/// `prt_0000000000` prefix sorts before any non-zero hex timestamp).
pub fn generate_thinking_part_id() -> String {
    let timestamp = format!("{:x}", now_ms());
    let counter = to_base36(THINKING_PART_COUNTER.fetch_add(1, Ordering::SeqCst));
    let mut bytes = [0u8; 3];
    rand::rng().fill_bytes(&mut bytes);
    let random: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("prt_0000000000_thinking_{timestamp}_{counter}_{random}")
}

// =============================================================================
// Directory helpers
// =============================================================================

/// TS `getMessageDir(sessionID)` — `""` (here: `None`) when not found.
/// Propagates the invalid-id error (gotcha 29).
pub fn get_message_dir(session_id: &str) -> Result<Option<PathBuf>, String> {
    validate_path_id(session_id, "sessionID")?;
    let root = message_storage();
    if !root.exists() {
        return Ok(None);
    }

    let direct = root.join(session_id);
    if direct.exists() {
        return Ok(Some(direct));
    }

    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let session_path = entry.path().join(session_id);
            if session_path.exists() {
                return Ok(Some(session_path));
            }
        }
    }

    Ok(None)
}

// =============================================================================
// Message / part reading
// =============================================================================

fn read_json_records<T, FValidate, FDetail>(
    dir: &Path,
    validate: FValidate,
    invalid_detail: FDetail,
) -> Vec<T>
where
    T: serde::de::DeserializeOwned,
    FValidate: Fn(&Value) -> bool,
    FDetail: Fn() -> &'static str,
{
    let mut records = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if !name.ends_with(".json") {
            continue;
        }
        let file_path = entry.path();
        match fs::read_to_string(&file_path) {
            Err(error) => {
                handle_unreadable_file(&file_path, ReadFailure::TransientIo(error));
            }
            Ok(content) => match serde_json::from_str::<Value>(&content) {
                Err(error) => {
                    handle_unreadable_file(&file_path, ReadFailure::Corrupt(error.to_string()));
                }
                Ok(parsed) => {
                    if !validate(&parsed) {
                        handle_unreadable_file(
                            &file_path,
                            ReadFailure::Corrupt(format!(
                                "invalid recovery record: {}",
                                invalid_detail()
                            )),
                        );
                        continue;
                    }
                    match serde_json::from_value::<T>(parsed) {
                        Ok(record) => records.push(record),
                        Err(error) => {
                            // Shape passed the validator but the struct parse
                            // failed (should not happen — permissive structs);
                            // treat like corruption for safety.
                            handle_unreadable_file(
                                &file_path,
                                ReadFailure::Corrupt(error.to_string()),
                            );
                        }
                    }
                }
            },
        }
    }
    records
}

/// TS `readMessages(sessionID)` — sorted by `time.created ?? 0` ascending,
/// ties by id (lexicographic).
pub fn read_messages(session_id: &str) -> Result<Vec<StoredMessageMeta>, String> {
    let Some(message_dir) = get_message_dir(session_id)? else {
        return Ok(Vec::new());
    };
    if !message_dir.exists() {
        return Ok(Vec::new());
    }

    let mut messages: Vec<StoredMessageMeta> = read_json_records(
        &message_dir,
        is_valid_stored_message,
        || "message missing string id",
    );

    messages.sort_by(|a, b| {
        let a_time = a.created_sort_key();
        let b_time = b.created_sort_key();
        match a_time.partial_cmp(&b_time) {
            Some(std::cmp::Ordering::Equal) | None => a.id.cmp(&b.id),
            Some(order) => order,
        }
    });
    Ok(messages)
}

/// TS `readParts(messageID)` — unsorted (directory order). Propagates the
/// invalid-id error (gotcha 29).
pub fn read_parts(message_id: &str) -> Result<Vec<StoredPart>, String> {
    validate_path_id(message_id, "messageID")?;
    let part_dir = part_storage().join(message_id);
    if !part_dir.exists() {
        return Ok(Vec::new());
    }
    Ok(read_json_records(
        &part_dir,
        is_valid_stored_part,
        || "part missing string id/type",
    ))
}

// =============================================================================
// Content helpers
// =============================================================================

/// TS `hasContent(part)`.
///
/// Note: the TS cast `part as StoredTextPart` means a non-string `text`
/// value would throw inside `hasContent`; the Rust port treats a non-string
/// `text` as blank (recorded deviation — the TS behavior is an accidental
/// crash on malformed data that validation already filters in practice).
pub fn has_content(part: &StoredPart) -> bool {
    let part_type = part.part_type.as_str();
    if is_thinking_type(part_type) || is_meta_type(part_type) {
        return false;
    }
    match part_type {
        "text" => part.text().is_some_and(|t| !t.trim().is_empty()),
        "tool" | "tool_use" | "tool_result" => true,
        _ => false,
    }
}

/// TS `messageHasContent(messageID)`.
pub fn message_has_content(message_id: &str) -> Result<bool, String> {
    Ok(read_parts(message_id)?.iter().any(has_content))
}

// =============================================================================
// Part injection (for recovery)
// =============================================================================

/// TS `injectTextPart` — writes a synthetic text part; `false` on any error.
pub fn inject_text_part(session_id: &str, message_id: &str, text: &str) -> bool {
    if validate_path_id(message_id, "messageID").is_err() {
        return false;
    }
    let part_dir = part_storage().join(message_id);
    if !part_dir.exists() && fs::create_dir_all(&part_dir).is_err() {
        return false;
    }

    let part_id = generate_part_id();
    let part = serde_json::json!({
        "id": part_id,
        "sessionID": session_id,
        "messageID": message_id,
        "type": "text",
        "text": text,
        "synthetic": true,
    });
    atomic_write_file_sync(
        &part_dir.join(format!("{part_id}.json")),
        &cma_core::json_io::stringify_pretty2(&part),
    )
    .is_ok()
}

// =============================================================================
// Thinking block recovery
// =============================================================================

/// TS `findMessagesWithThinkingBlocks`.
pub fn find_messages_with_thinking_blocks(session_id: &str) -> Result<Vec<String>, String> {
    let messages = read_messages(session_id)?;
    let mut result = Vec::new();
    for msg in &messages {
        if !msg.is_assistant() {
            continue;
        }
        let parts = read_parts(&msg.id)?;
        if parts.iter().any(|p| is_thinking_type(&p.part_type)) {
            result.push(msg.id.clone());
        }
    }
    Ok(result)
}

/// TS `findMessagesWithThinkingOnly` — assistant messages with parts that
/// have thinking but no content (orphan thinking).
pub fn find_messages_with_thinking_only(session_id: &str) -> Result<Vec<String>, String> {
    let messages = read_messages(session_id)?;
    let mut result = Vec::new();
    for msg in &messages {
        if !msg.is_assistant() {
            continue;
        }
        let parts = read_parts(&msg.id)?;
        if parts.is_empty() {
            continue;
        }
        let has_thinking = parts.iter().any(|p| is_thinking_type(&p.part_type));
        let has_text_content = parts.iter().any(has_content);
        if has_thinking && !has_text_content {
            result.push(msg.id.clone());
        }
    }
    Ok(result)
}

/// TS `findMessagesWithOrphanThinking` — assistant messages whose id-sorted
/// FIRST part is not a thinking type (i.e. messages *missing* a leading
/// thinking block; the TS name is historically confusing).
pub fn find_messages_with_orphan_thinking(session_id: &str) -> Result<Vec<String>, String> {
    let messages = read_messages(session_id)?;
    let mut result = Vec::new();
    for msg in &messages {
        if !msg.is_assistant() {
            continue;
        }
        let mut parts = read_parts(&msg.id)?;
        if parts.is_empty() {
            continue;
        }
        parts.sort_by(|a, b| a.id.cmp(&b.id));
        let first = &parts[0];
        if !is_thinking_type(&first.part_type) {
            result.push(msg.id.clone());
        }
    }
    Ok(result)
}

/// TS `prependThinkingPart` — writes a synthetic empty thinking part whose id
/// sorts before every real part id; `false` on any error.
pub fn prepend_thinking_part(session_id: &str, message_id: &str) -> bool {
    if validate_path_id(message_id, "messageID").is_err() {
        return false;
    }
    let part_dir = part_storage().join(message_id);
    if !part_dir.exists() && fs::create_dir_all(&part_dir).is_err() {
        return false;
    }

    let part_id = generate_thinking_part_id();
    let part = serde_json::json!({
        "id": part_id,
        "sessionID": session_id,
        "messageID": message_id,
        "type": "thinking",
        "thinking": "",
        "synthetic": true,
    });
    atomic_write_file_sync(
        &part_dir.join(format!("{part_id}.json")),
        &cma_core::json_io::stringify_pretty2(&part),
    )
    .is_ok()
}

/// TS `stripThinkingParts` — removes every thinking-type part file. Reports
/// success ONLY when at least one part was removed and no targeted part
/// survived (recovery-05: a survivor would loop auto-resume forever).
pub fn strip_thinking_parts(message_id: &str) -> bool {
    if validate_path_id(message_id, "messageID").is_err() {
        return false;
    }
    let part_dir = part_storage().join(message_id);
    if !part_dir.exists() {
        return false;
    }

    let mut any_removed = false;
    let mut any_target_failed = false;
    let entries = match fs::read_dir(&part_dir) {
        Ok(entries) => entries,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if !name.ends_with(".json") {
            continue;
        }
        let file_path = entry.path();
        let Ok(content) = fs::read_to_string(&file_path) else {
            continue;
        };
        let Ok(part) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        let part_type = part.get("type").and_then(Value::as_str).unwrap_or("");
        if is_thinking_type(part_type) {
            if safe_unlink_with_retry(&file_path, 4) {
                any_removed = true;
            } else {
                any_target_failed = true;
            }
        }
    }

    any_removed && !any_target_failed
}

// =============================================================================
// Empty message recovery
// =============================================================================

/// TS `findEmptyMessages` — all messages (any role) with no content part.
pub fn find_empty_messages(session_id: &str) -> Result<Vec<String>, String> {
    let messages = read_messages(session_id)?;
    let mut empty_ids = Vec::new();
    for msg in &messages {
        if !message_has_content(&msg.id)? {
            empty_ids.push(msg.id.clone());
        }
    }
    Ok(empty_ids)
}

/// TS `findEmptyMessageByIndex` — probes indexes `[i, i-1, i-2]` to bridge
/// API-vs-storage index skew (gotcha 34).
pub fn find_empty_message_by_index(
    session_id: &str,
    target_index: i64,
) -> Result<Option<String>, String> {
    let messages = read_messages(session_id)?;

    for idx in [target_index, target_index - 1, target_index - 2] {
        if idx < 0 || idx >= messages.len() as i64 {
            continue;
        }
        let target = &messages[idx as usize];
        if !target.is_assistant() {
            continue;
        }
        if !message_has_content(&target.id)? {
            return Ok(Some(target.id.clone()));
        }
    }
    Ok(None)
}

/// TS `findMessageByIndexNeedingThinking` — exact index only (does NOT probe
/// neighbors, gotcha 34).
pub fn find_message_by_index_needing_thinking(
    session_id: &str,
    target_index: i64,
) -> Result<Option<String>, String> {
    let messages = read_messages(session_id)?;
    if target_index < 0 || target_index >= messages.len() as i64 {
        return Ok(None);
    }
    let target = &messages[target_index as usize];
    if !target.is_assistant() {
        return Ok(None);
    }
    let mut parts = read_parts(&target.id)?;
    if parts.is_empty() {
        return Ok(None);
    }
    parts.sort_by(|a, b| a.id.cmp(&b.id));
    if !is_thinking_type(&parts[0].part_type) {
        return Ok(Some(target.id.clone()));
    }
    Ok(None)
}

/// TS `replaceEmptyTextParts` — sets blank `text` parts to the replacement
/// text (+ `synthetic: true`), pretty-JSON atomic rewrite preserving other
/// fields and key order. `true` iff any part was replaced.
pub fn replace_empty_text_parts(message_id: &str, replacement_text: &str) -> bool {
    if validate_path_id(message_id, "messageID").is_err() {
        return false;
    }
    let part_dir = part_storage().join(message_id);
    if !part_dir.exists() {
        return false;
    }

    let mut any_replaced = false;
    let entries = match fs::read_dir(&part_dir) {
        Ok(entries) => entries,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if !name.ends_with(".json") {
            continue;
        }
        let file_path = entry.path();
        let Ok(content) = fs::read_to_string(&file_path) else {
            continue;
        };
        let Ok(mut part) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        let is_text = part.get("type").and_then(Value::as_str) == Some("text");
        if !is_text {
            continue;
        }
        let blank = part
            .get("text")
            .and_then(Value::as_str)
            .is_none_or(|t| t.trim().is_empty());
        if !blank {
            continue;
        }
        if let Some(obj) = part.as_object_mut() {
            obj.insert("text".to_string(), Value::String(replacement_text.to_string()));
            obj.insert("synthetic".to_string(), Value::Bool(true));
        }
        if atomic_write_file_sync(&file_path, &cma_core::json_io::stringify_pretty2(&part)).is_ok()
        {
            any_replaced = true;
        }
    }

    any_replaced
}

/// TS `findMessagesWithEmptyTextParts`.
pub fn find_messages_with_empty_text_parts(session_id: &str) -> Result<Vec<String>, String> {
    let messages = read_messages(session_id)?;
    let mut result = Vec::new();
    for msg in &messages {
        let parts = read_parts(&msg.id)?;
        let has_empty_text = parts.iter().any(|p| {
            p.part_type == "text" && p.text().is_none_or(|t| t.trim().is_empty())
        });
        if has_empty_text {
            result.push(msg.id.clone());
        }
    }
    Ok(result)
}

// =============================================================================
// Tests — ported from test/recovery-storage.test.ts (P0)
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    /// Point the recovery storage root at the sandbox and return the
    /// message/part dirs.
    fn setup_storage(sandbox: &mut EnvSandbox) -> (PathBuf, PathBuf) {
        let data_root = sandbox.root().join("xdg-data");
        #[cfg(windows)]
        sandbox.set_var("APPDATA", &data_root);
        #[cfg(not(windows))]
        sandbox.set_var("XDG_DATA_HOME", &data_root);
        __reset_recovery_corruption_stats();
        (message_storage(), part_storage())
    }

    fn write_json(path: &Path, value: &Value) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
    }

    #[test]
    #[serial(env)]
    fn generate_part_id_includes_prefix_timestamp_random() {
        let id = generate_part_id();
        assert!(id.starts_with("prt_"));
        assert!(id.len() > "prt_".len() + 8);
        assert_ne!(generate_part_id(), id);
    }

    #[test]
    #[serial(env)]
    fn get_message_dir_missing_base_returns_none() {
        let mut sandbox = EnvSandbox::new();
        let _ = setup_storage(&mut sandbox);
        assert_eq!(get_message_dir("ses1").unwrap(), None);
    }

    #[test]
    #[serial(env)]
    fn get_message_dir_finds_direct_and_nested() {
        let mut sandbox = EnvSandbox::new();
        let (msg_root, _) = setup_storage(&mut sandbox);
        fs::create_dir_all(msg_root.join("sesdirect")).unwrap();
        assert_eq!(
            get_message_dir("sesdirect").unwrap(),
            Some(msg_root.join("sesdirect"))
        );

        fs::create_dir_all(msg_root.join("proj").join("sesnested")).unwrap();
        assert_eq!(
            get_message_dir("sesnested").unwrap(),
            Some(msg_root.join("proj").join("sesnested"))
        );
    }

    #[test]
    #[serial(env)]
    fn read_messages_sorts_and_skips_invalid() {
        let mut sandbox = EnvSandbox::new();
        let (msg_root, _) = setup_storage(&mut sandbox);
        let dir = msg_root.join("ses1");
        write_json(
            &dir.join("b.json"),
            &serde_json::json!({"id": "m2", "sessionID": "ses1", "role": "assistant", "time": {"created": 200}}),
        );
        write_json(
            &dir.join("a.json"),
            &serde_json::json!({"id": "m1", "sessionID": "ses1", "role": "user", "time": {"created": 100}}),
        );
        fs::write(dir.join("broken.json"), "{not json").unwrap();
        fs::write(dir.join("ignored.txt"), "nope").unwrap();

        let messages = read_messages("ses1").unwrap();
        assert_eq!(
            messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["m1", "m2"]
        );
        // The broken file was quarantined.
        let (count, paths) = get_recovery_corruption_stats();
        assert_eq!(count, 1);
        assert_eq!(paths.len(), 1);
        assert!(paths[0].contains("broken.json.corrupt-"));
        assert!(!dir.join("broken.json").exists());
    }

    #[test]
    #[serial(env)]
    fn read_messages_quarantines_invalid_shape_records() {
        let mut sandbox = EnvSandbox::new();
        let (msg_root, _) = setup_storage(&mut sandbox);
        let dir = msg_root.join("ses2");
        // Missing id.
        write_json(&dir.join("noid.json"), &serde_json::json!({"role": "assistant"}));
        // Path-unsafe id (recovery-02).
        write_json(
            &dir.join("evil.json"),
            &serde_json::json!({"id": "../poison", "role": "assistant"}),
        );
        // Non-numeric time.created (recovery-02).
        write_json(
            &dir.join("badtime.json"),
            &serde_json::json!({"id": "m3", "time": {"created": "oops"}}),
        );
        let messages = read_messages("ses2").unwrap();
        assert!(messages.is_empty());
        let (count, _) = get_recovery_corruption_stats();
        assert_eq!(count, 3);
    }

    #[test]
    #[serial(env)]
    fn read_parts_parses_and_quarantines() {
        let mut sandbox = EnvSandbox::new();
        let (_, part_root) = setup_storage(&mut sandbox);
        assert!(read_parts("m1").unwrap().is_empty());

        let dir = part_root.join("m1");
        write_json(
            &dir.join("p1.json"),
            &serde_json::json!({"id": "p1", "sessionID": "s", "messageID": "m1", "type": "text", "text": "hi"}),
        );
        // Parseable but missing type (recovery-02).
        write_json(&dir.join("p2.json"), &serde_json::json!({"id": "p2"}));
        fs::write(dir.join("p3.json"), "{oops").unwrap();

        let parts = read_parts("m1").unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].id, "p1");
        let (count, _) = get_recovery_corruption_stats();
        assert_eq!(count, 2);
    }

    #[test]
    #[serial(env)]
    fn read_paths_reject_unsafe_ids() {
        let mut sandbox = EnvSandbox::new();
        let _ = setup_storage(&mut sandbox);
        let err = read_parts("../evil").unwrap_err();
        assert_eq!(err, "Invalid messageID: contains unsafe characters");
        let err = get_message_dir("a/b").unwrap_err();
        assert_eq!(err, "Invalid sessionID: contains unsafe characters");
    }

    #[test]
    #[serial(env)]
    fn has_content_classification_matches_ts() {
        let part = |t: &str, text: Option<&str>| -> StoredPart {
            let mut value = serde_json::json!({"id": "p", "sessionID": "s", "messageID": "m", "type": t});
            if let Some(text) = text {
                value["text"] = Value::String(text.to_string());
            }
            serde_json::from_value(value).unwrap()
        };
        assert!(!has_content(&part("thinking", Some("x"))));
        assert!(!has_content(&part("redacted_thinking", None)));
        assert!(!has_content(&part("reasoning", None)));
        assert!(!has_content(&part("step-start", None)));
        assert!(!has_content(&part("step-finish", None)));
        assert!(has_content(&part("text", Some("hello"))));
        assert!(!has_content(&part("text", Some("   "))));
        assert!(!has_content(&part("text", None)));
        assert!(has_content(&part("tool", None)));
        assert!(has_content(&part("tool_use", None)));
        assert!(has_content(&part("tool_result", None)));
        assert!(!has_content(&part("mystery", None)));
    }

    #[test]
    #[serial(env)]
    fn inject_text_part_writes_synthetic_part() {
        let mut sandbox = EnvSandbox::new();
        let (_, part_root) = setup_storage(&mut sandbox);
        assert!(inject_text_part("ses1", "m1", "recovered"));
        let dir = part_root.join("m1");
        let files: Vec<_> = fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(files.len(), 1);
        let written: Value =
            serde_json::from_str(&fs::read_to_string(files[0].path()).unwrap()).unwrap();
        assert_eq!(written["type"], "text");
        assert_eq!(written["text"], "recovered");
        assert_eq!(written["synthetic"], true);
        assert_eq!(written["sessionID"], "ses1");
        assert_eq!(written["messageID"], "m1");
        // Rejects unsafe ids.
        assert!(!inject_text_part("ses1", "../evil", "x"));
    }

    #[test]
    #[serial(env)]
    fn thinking_finders_match_ts_semantics() {
        let mut sandbox = EnvSandbox::new();
        let (msg_root, part_root) = setup_storage(&mut sandbox);
        let dir = msg_root.join("ses1");
        write_json(
            &dir.join("m1.json"),
            &serde_json::json!({"id": "m1", "role": "assistant", "time": {"created": 1}}),
        );
        write_json(
            &dir.join("m2.json"),
            &serde_json::json!({"id": "m2", "role": "assistant", "time": {"created": 2}}),
        );
        write_json(
            &dir.join("m3.json"),
            &serde_json::json!({"id": "m3", "role": "user", "time": {"created": 3}}),
        );
        // m1: thinking first + text content.
        write_json(
            &part_root.join("m1").join("a.json"),
            &serde_json::json!({"id": "p0", "sessionID": "ses1", "messageID": "m1", "type": "thinking", "thinking": "t"}),
        );
        write_json(
            &part_root.join("m1").join("b.json"),
            &serde_json::json!({"id": "p1", "sessionID": "ses1", "messageID": "m1", "type": "text", "text": "content"}),
        );
        // m2: text only (first sorted part not thinking).
        write_json(
            &part_root.join("m2").join("a.json"),
            &serde_json::json!({"id": "p2", "sessionID": "ses1", "messageID": "m2", "type": "text", "text": "content"}),
        );

        assert_eq!(find_messages_with_thinking_blocks("ses1").unwrap(), vec!["m1"]);
        assert!(find_messages_with_thinking_only("ses1").unwrap().is_empty());
        assert_eq!(find_messages_with_orphan_thinking("ses1").unwrap(), vec!["m2"]);

        // Orphan thinking (thinking but no content) on m2 after adding
        // thinking and removing text.
        fs::remove_file(part_root.join("m2").join("a.json")).unwrap();
        write_json(
            &part_root.join("m2").join("t.json"),
            &serde_json::json!({"id": "p3", "sessionID": "ses1", "messageID": "m2", "type": "thinking", "thinking": ""}),
        );
        assert_eq!(find_messages_with_thinking_only("ses1").unwrap(), vec!["m2"]);
    }

    #[test]
    #[serial(env)]
    fn prepend_thinking_part_generates_unique_sorted_ids() {
        let mut sandbox = EnvSandbox::new();
        let (_, part_root) = setup_storage(&mut sandbox);
        assert!(prepend_thinking_part("ses1", "m1"));
        assert!(prepend_thinking_part("ses1", "m1"));
        let files: Vec<_> = fs::read_dir(part_root.join("m1")).unwrap().flatten().collect();
        // RPTU-001: repeat passes must not overwrite the prior synthetic part.
        assert_eq!(files.len(), 2);

        // Synthetic ids sort before real generate_part_id output.
        let synthetic = generate_thinking_part_id();
        let real = generate_part_id();
        assert!(synthetic < real, "{synthetic} should sort before {real}");
    }

    #[test]
    #[serial(env)]
    fn strip_thinking_parts_removes_only_thinking() {
        let mut sandbox = EnvSandbox::new();
        let (_, part_root) = setup_storage(&mut sandbox);
        assert!(!strip_thinking_parts("mmissing"));

        let dir = part_root.join("m1");
        write_json(
            &dir.join("think.json"),
            &serde_json::json!({"id": "p1", "sessionID": "s", "messageID": "m1", "type": "thinking", "thinking": "x"}),
        );
        write_json(
            &dir.join("text.json"),
            &serde_json::json!({"id": "p2", "sessionID": "s", "messageID": "m1", "type": "text", "text": "keep"}),
        );
        assert!(strip_thinking_parts("m1"));
        assert!(!dir.join("think.json").exists());
        assert!(dir.join("text.json").exists());
        // Nothing left to remove now.
        assert!(!strip_thinking_parts("m1"));
        // Unsafe id → false, not panic.
        assert!(!strip_thinking_parts("../evil"));
    }

    #[test]
    #[serial(env)]
    fn empty_message_index_probing_matches_ts() {
        let mut sandbox = EnvSandbox::new();
        let (msg_root, part_root) = setup_storage(&mut sandbox);
        let dir = msg_root.join("ses1");
        for (i, id) in ["m1", "m2", "m3"].iter().enumerate() {
            write_json(
                &dir.join(format!("{id}.json")),
                &serde_json::json!({"id": id, "role": "assistant", "time": {"created": i as i64 + 1}}),
            );
        }
        // Only m2 has content.
        write_json(
            &part_root.join("m2").join("p.json"),
            &serde_json::json!({"id": "p1", "sessionID": "ses1", "messageID": "m2", "type": "text", "text": "content"}),
        );

        assert_eq!(find_empty_messages("ses1").unwrap(), vec!["m1", "m3"]);
        // Exact index empty → hit.
        assert_eq!(find_empty_message_by_index("ses1", 0).unwrap(), Some("m1".into()));
        // Index 1 has content → fallback probes index 0 (i-1).
        assert_eq!(find_empty_message_by_index("ses1", 1).unwrap(), Some("m1".into()));
        // Out of range probes fall back into range.
        assert_eq!(find_empty_message_by_index("ses1", 4).unwrap(), Some("m3".into()));

        // findMessageByIndexNeedingThinking: exact index only.
        assert_eq!(
            find_message_by_index_needing_thinking("ses1", 5).unwrap(),
            None
        );
        assert_eq!(
            find_message_by_index_needing_thinking("ses1", 1).unwrap(),
            Some("m2".into())
        );
        // m1 has no parts → null.
        assert_eq!(find_message_by_index_needing_thinking("ses1", 0).unwrap(), None);
    }

    #[test]
    #[serial(env)]
    fn replace_empty_text_parts_rewrites_blank_text() {
        let mut sandbox = EnvSandbox::new();
        let (_, part_root) = setup_storage(&mut sandbox);
        let dir = part_root.join("m1");
        write_json(
            &dir.join("blank.json"),
            &serde_json::json!({"id": "p1", "sessionID": "s", "messageID": "m1", "type": "text", "text": "  "}),
        );
        write_json(
            &dir.join("full.json"),
            &serde_json::json!({"id": "p2", "sessionID": "s", "messageID": "m1", "type": "text", "text": "keep"}),
        );
        assert!(replace_empty_text_parts("m1", "[recovered]"));
        let blank: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("blank.json")).unwrap()).unwrap();
        assert_eq!(blank["text"], "[recovered]");
        assert_eq!(blank["synthetic"], true);
        let full: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("full.json")).unwrap()).unwrap();
        assert_eq!(full["text"], "keep");
        assert!(full.get("synthetic").is_none());

        assert_eq!(find_messages_with_empty_text_parts("ses-none").unwrap(), Vec::<String>::new());
    }
}
