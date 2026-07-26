//! Port of `lib/named-backup-export.ts` + `lib/storage/named-backups.ts`
//! (+ the `named-backup-entry` / `named-backups-entry` wiring from
//! `lib/storage.ts`) — spec 02 §12.3.
//!
//! - [`normalize_named_backup_file_name`]: exact frozen error strings.
//! - Root containment via realpath ([`assert_within_directory`]): the backup
//!   root must not be a symlink and its realpath must equal its resolved
//!   path; candidates are compared through realpath-of-parent + basename.
//!   Windows comparisons are lowercase/case-insensitive.
//! - Per-process in-flight export set keyed by the realpath-normalized
//!   destination; collisions raise the same "File already exists" string as
//!   the on-disk case (gotcha 34).
//! - [`get_named_backups`]: mtime DESC, tie by fileName ASC; empty/invalid
//!   backups skipped silently (debug log only) — gotcha 28.

// `CodexError` is core's frozen error shape (192 bytes); the sibling-crate API
// contract pins these `Result<_, CodexError>` signatures, so boxing is not an
// option here.
#![allow(clippy::result_large_err)]

use std::collections::HashSet;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex as StdMutex;
use std::time::UNIX_EPOCH;

use serde_json::json;

use cma_core::errors::CodexError;
use cma_core::fs_retry::code_of;
use cma_core::logger::create_logger;

const BACKUP_EXPORT_DIR_NAME: &str = "backups";
const BACKUP_FILE_EXTENSION: &str = ".json";
const BACKUP_INVALID_SUFFIXES: [&str; 2] = [".tmp", ".wal"];
const BACKUP_PROHIBITED_SUBSTRINGS: [&str; 1] = [".rotate."];

static IN_FLIGHT_NAMED_BACKUP_EXPORTS: StdMutex<Option<HashSet<String>>> = StdMutex::new(None);

fn io_to_codex(error: io::Error) -> CodexError {
    let mapped = CodexError::new(error.to_string());
    match code_of(&error) {
        Some(code) => mapped.with_code(code).with_cause(error),
        None => mapped.with_cause(error),
    }
}

/// `resolvePath` boundary with its frozen `Error` messages surfaced as plain
/// `CodexError`s, path returned as a String (TS works in strings throughout).
fn resolve_path_string(path: &str) -> Result<String, CodexError> {
    match crate::paths::resolve_path(path) {
        Ok(resolved) => Ok(resolved.to_string_lossy().into_owned()),
        Err(error) => Err(CodexError::new(error.0)),
    }
}

fn storage_path_string() -> String {
    // PathBuf::from accepts both String and PathBuf — resilient to the
    // facade's concrete return type while the crate is co-authored.
    PathBuf::from(crate::facade::get_storage_path())
        .to_string_lossy()
        .into_owned()
}

// ============================================================================
// Node-flavored path helpers (shared with backup_restore via pub(crate))
// ============================================================================

/// `path.resolve` analogue: absolute-ize against cwd, then lexically
/// normalize (collapse `.`/`..`, native separators). No filesystem access.
pub(crate) fn node_resolve(path: &str) -> String {
    let p = Path::new(path);
    let joined: PathBuf = if p.is_absolute() {
        p.to_path_buf()
    } else {
        let cwd = std::env::current_dir().unwrap_or_default();
        if cfg!(windows) && p.has_root() {
            // win32 `\foo` resolves onto the cwd's drive.
            let mut prefixed = PathBuf::new();
            if let Some(Component::Prefix(prefix)) = cwd.components().next() {
                prefixed.push(prefix.as_os_str());
            }
            prefixed.push(p);
            prefixed
        } else {
            cwd.join(p)
        }
    };
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(std::path::MAIN_SEPARATOR_STR),
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(
                    normalized.components().next_back(),
                    None | Some(Component::Prefix(_)) | Some(Component::RootDir)
                ) {
                    normalized.pop();
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized.to_string_lossy().into_owned()
}

/// `path.isAbsolute` analogue.
pub(crate) fn is_absolute_path(path: &str) -> bool {
    if cfg!(windows) {
        Path::new(path).is_absolute() || Path::new(path).has_root()
    } else {
        Path::new(path).is_absolute()
    }
}

fn comparable_component(component: &str) -> String {
    if cfg!(windows) {
        component.to_lowercase()
    } else {
        component.to_string()
    }
}

fn split_for_relative(path: &str) -> (String, Vec<String>) {
    let mut prefix = String::new();
    let mut parts = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::Prefix(p) => prefix = p.as_os_str().to_string_lossy().into_owned(),
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => parts.push("..".to_string()),
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
        }
    }
    (prefix, parts)
}

/// `path.relative` analogue (win32 comparison is case-insensitive, like
/// Node). Different Windows drives return `to` unchanged (absolute — fails
/// containment, matching Node).
pub(crate) fn path_relative(from: &str, to: &str) -> String {
    let from_resolved = node_resolve(from);
    let to_resolved = node_resolve(to);
    let (from_prefix, from_parts) = split_for_relative(&from_resolved);
    let (to_prefix, to_parts) = split_for_relative(&to_resolved);
    if comparable_component(&from_prefix) != comparable_component(&to_prefix) {
        return to_resolved;
    }
    let mut common = 0usize;
    while common < from_parts.len()
        && common < to_parts.len()
        && comparable_component(&from_parts[common]) == comparable_component(&to_parts[common])
    {
        common += 1;
    }
    let mut pieces: Vec<String> = Vec::new();
    for _ in common..from_parts.len() {
        pieces.push("..".to_string());
    }
    pieces.extend(to_parts[common..].iter().cloned());
    pieces.join(std::path::MAIN_SEPARATOR_STR)
}

/// Strip Windows verbatim prefixes (`\\?\`, `\\?\UNC\`) so canonicalized
/// paths compare like Node `realpathSync` output.
fn strip_verbatim(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        raw.into_owned()
    }
}

/// `realpathSync` analogue.
pub(crate) fn realpath_compat(path: &str) -> io::Result<String> {
    std::fs::canonicalize(path).map(|canonical| strip_verbatim(&canonical))
}

/// TS `normalizePathForComparison` — resolve, realpath when the path exists,
/// lowercase on Windows.
fn normalize_path_for_comparison(path_value: &str) -> Result<String, CodexError> {
    let resolved_path = node_resolve(path_value);
    let canonical_path = if Path::new(&resolved_path).exists() {
        realpath_compat(&resolved_path).map_err(io_to_codex)?
    } else {
        resolved_path
    };
    Ok(if cfg!(windows) {
        canonical_path.to_lowercase()
    } else {
        canonical_path
    })
}

fn dirname(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|parent| parent.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// TS `assertWithinDirectory` — the containment guard for named backups.
/// Frozen error string: "Named backup path escapes the backup root".
pub(crate) fn assert_within_directory(base_dir: &str, target_path: &str) -> Result<(), CodexError> {
    const ESCAPE: &str = "Named backup path escapes the backup root";
    let resolved_base = node_resolve(base_dir);
    let base_stat = match std::fs::symlink_metadata(&resolved_base) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(io_to_codex(error)),
    };
    if let Some(base_stat) = base_stat {
        if base_stat.file_type().is_symlink() {
            return Err(CodexError::new(ESCAPE));
        }
        let canonical_base = realpath_compat(&resolved_base).map_err(io_to_codex)?;
        let comparable_canonical_base = if cfg!(windows) {
            canonical_base.to_lowercase()
        } else {
            canonical_base
        };
        let comparable_resolved_base = if cfg!(windows) {
            resolved_base.to_lowercase()
        } else {
            resolved_base.clone()
        };
        if comparable_canonical_base != comparable_resolved_base {
            return Err(CodexError::new(ESCAPE));
        }
    }
    let normalized_base = normalize_path_for_comparison(base_dir)?;
    let target_parent = dirname(target_path);
    let normalized_target_parent = normalize_path_for_comparison(&target_parent)?;
    let normalized_target = format!(
        "{normalized_target_parent}{}{}",
        std::path::MAIN_SEPARATOR,
        basename(target_path)
    );
    let rel = path_relative(&normalized_base, &normalized_target);
    if rel.is_empty() || (!rel.starts_with("..") && !is_absolute_path(&rel)) {
        return Ok(());
    }
    Err(CodexError::new(ESCAPE))
}

// ============================================================================
// Name validation (frozen error strings)
// ============================================================================

fn is_windows_reserved_name(base_name: &str) -> bool {
    let lower = base_name.to_lowercase();
    if matches!(lower.as_str(), "con" | "prn" | "aux" | "nul") {
        return true;
    }
    if lower.len() == 4 && (lower.starts_with("com") || lower.starts_with("lpt")) {
        return lower.as_bytes()[3].is_ascii_digit() && lower.as_bytes()[3] != b'0';
    }
    false
}

/// TS `normalizeNamedBackupFileName` — validate + normalize into
/// `<name>.json`. Every error string is FROZEN (CLI matches on them).
pub fn normalize_named_backup_file_name(name: &str) -> Result<String, CodexError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(CodexError::new("Named backup requires a non-empty filename"));
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(CodexError::new(
            "Backup filename must not contain path separators",
        ));
    }
    if trimmed.contains("..") {
        return Err(CodexError::new(
            "Backup filename must not contain traversal tokens",
        ));
    }

    let lower = trimmed.to_lowercase();
    if BACKUP_PROHIBITED_SUBSTRINGS
        .iter()
        .any(|value| lower.contains(value))
    {
        return Err(CodexError::new(
            "Backup filename may not contain rotation-style sequences",
        ));
    }

    let base_name = if lower.ends_with(BACKUP_FILE_EXTENSION) {
        &trimmed[..trimmed.len() - BACKUP_FILE_EXTENSION.len()]
    } else {
        trimmed
    };
    if base_name.is_empty() {
        return Err(CodexError::new("Backup filename cannot be just an extension"));
    }
    let base_lower = base_name.to_lowercase();
    if BACKUP_INVALID_SUFFIXES
        .iter()
        .any(|value| base_lower.ends_with(value))
    {
        return Err(CodexError::new(
            "Backup filename may not end with temporary suffixes",
        ));
    }
    if is_windows_reserved_name(base_name) {
        return Err(CodexError::new(
            "Backup filename may not use a reserved Windows device name",
        ));
    }
    let is_safe = !base_name.is_empty()
        && base_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !is_safe {
        return Err(CodexError::new(
            "Backup filename may only contain letters, numbers, hyphens, and underscores; dots (.) are not allowed",
        ));
    }

    Ok(format!("{base_name}{BACKUP_FILE_EXTENSION}"))
}

// ============================================================================
// Root / path resolution
// ============================================================================

/// TS `getNamedBackupRoot(storagePath)` = resolvePath(dirname(resolvePath(
/// storagePath)) + "/backups").
pub fn get_named_backup_root(storage_path: &str) -> Result<String, CodexError> {
    let resolved_storage_path = resolve_path_string(storage_path)?;
    let joined = format!(
        "{}{}{}",
        dirname(&resolved_storage_path),
        std::path::MAIN_SEPARATOR,
        BACKUP_EXPORT_DIR_NAME
    );
    resolve_path_string(&joined)
}

/// TS `resolveNamedBackupPath(name, storagePath)`.
pub fn resolve_named_backup_path(name: &str, storage_path: &str) -> Result<String, CodexError> {
    let file_name = normalize_named_backup_file_name(name)?;
    let backup_root = get_named_backup_root(storage_path)?;
    let candidate_input =
        format!("{backup_root}{}{file_name}", std::path::MAIN_SEPARATOR);
    let candidate = resolve_path_string(&candidate_input)?;
    assert_within_directory(&backup_root, &candidate)?;
    Ok(candidate)
}

/// TS `buildNamedBackupPath(name)` (storage.ts export).
pub fn build_named_backup_path(name: &str) -> Result<String, CodexError> {
    resolve_named_backup_path(name, &storage_path_string())
}

// ============================================================================
// Export (named-backup-export.ts exportNamedBackupFile + entry wiring)
// ============================================================================

fn in_flight_contains_or_insert(key: &str) -> bool {
    let mut guard = IN_FLIGHT_NAMED_BACKUP_EXPORTS
        .lock()
        .expect("in-flight set poisoned");
    let set = guard.get_or_insert_with(HashSet::new);
    if set.contains(key) {
        return true;
    }
    set.insert(key.to_string());
    false
}

fn in_flight_remove(key: &str) {
    let mut guard = IN_FLIGHT_NAMED_BACKUP_EXPORTS
        .lock()
        .expect("in-flight set poisoned");
    if let Some(set) = guard.as_mut() {
        set.remove(key);
    }
}

/// TS `exportNamedBackup(name, {force})` — validate, guard, export through
/// [`crate::import_export::export_accounts`] with a beforeCommit containment
/// re-assert. Returns the destination path.
pub async fn export_named_backup(name: &str, force: bool) -> Result<String, CodexError> {
    let storage_path = storage_path_string();
    let destination = resolve_named_backup_path(name, &storage_path)?;
    let backup_root = get_named_backup_root(&storage_path)?;
    let export_key = normalize_path_for_comparison(&destination)?;
    if in_flight_contains_or_insert(&export_key) {
        return Err(CodexError::new(format!(
            "File already exists: {destination}"
        )));
    }
    // TS ordering preserved: the containment assert + mkdir run AFTER the
    // in-flight key is added but OUTSIDE the try/finally — a failure there
    // leaves the key registered for the process lifetime (bug-compatible).
    assert_within_directory(&dirname(&backup_root), &backup_root)?;
    tokio::fs::create_dir_all(&backup_root)
        .await
        .map_err(io_to_codex)?;
    let before_commit =
        |resolved_path: &str| assert_within_directory(&backup_root, resolved_path);
    let result =
        crate::import_export::export_accounts(&destination, force, Some(&before_commit)).await;
    in_flight_remove(&export_key);
    result.map(|()| destination)
}

// ============================================================================
// Listing (named-backups.ts collectNamedBackups + entry wiring)
// ============================================================================

/// TS `NamedBackupSummary`.
#[derive(Clone, Debug, PartialEq)]
pub struct NamedBackupSummary {
    pub path: String,
    pub file_name: String,
    pub account_count: usize,
    pub mtime_ms: f64,
}

fn mtime_ms_of(metadata: &std::fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// TS `getNamedBackups()` — list `<root>/*.json` backups with account
/// counts, mtime DESC / fileName ASC.
pub async fn get_named_backups() -> Result<Vec<NamedBackupSummary>, CodexError> {
    let log = create_logger("storage");
    let backup_root = get_named_backup_root(&storage_path_string())?;
    let mut read_dir = match tokio::fs::read_dir(&backup_root).await {
        Ok(read_dir) => read_dir,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(io_to_codex(error)),
    };

    let mut candidates: Vec<NamedBackupSummary> = Vec::new();
    loop {
        let entry = match read_dir.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            // readdir iteration failures behave like the TS readdir throw.
            Err(error) => return Err(io_to_codex(error)),
        };
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let is_file = entry
            .file_type()
            .await
            .map(|file_type| file_type.is_file())
            .unwrap_or(false);
        if !is_file || !file_name.to_lowercase().ends_with(".json") {
            continue;
        }
        let candidate_path = format!(
            "{backup_root}{}{file_name}",
            std::path::MAIN_SEPARATOR
        );
        let attempt: Result<(std::fs::Metadata, crate::parser::ParsedStorage), String> = async {
            let stats_before = tokio::fs::metadata(&candidate_path)
                .await
                .map_err(|error| error.to_string())?;
            let parsed = crate::parser::load_accounts_from_path(Path::new(&candidate_path))
                .await
                .map_err(|error| error.to_string())?;
            Ok((stats_before, parsed))
        }
        .await;
        match attempt {
            Ok((stats_before, parsed)) => {
                let Some(normalized) = parsed.normalized else {
                    continue;
                };
                if normalized.accounts.is_empty() {
                    continue;
                }
                if let Ok(stats_after) = tokio::fs::metadata(&candidate_path).await {
                    let before_ms = mtime_ms_of(&stats_before);
                    let after_ms = mtime_ms_of(&stats_after);
                    if after_ms != before_ms {
                        log.debug(
                            "backup file changed between stat and load, mtime may be stale",
                            Some(&json!({
                                "candidatePath": candidate_path,
                                "fileName": file_name,
                                "beforeMtimeMs": before_ms,
                                "afterMtimeMs": after_ms,
                            })),
                        );
                    }
                }
                candidates.push(NamedBackupSummary {
                    path: candidate_path,
                    file_name,
                    account_count: normalized.accounts.len(),
                    mtime_ms: mtime_ms_of(&stats_before),
                });
            }
            Err(error) => {
                log.debug(
                    "Skipping named backup candidate after loadAccountsFromPath/fs.stat failure",
                    Some(&json!({
                        "candidatePath": candidate_path,
                        "fileName": file_name,
                        "error": error.to_string(),
                    })),
                );
            }
        }
    }

    candidates.sort_by(|left, right| {
        right
            .mtime_ms
            .partial_cmp(&left.mtime_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.file_name.cmp(&right.file_name))
    });
    Ok(candidates)
}

// ============================================================================
// Tests (ported from test/named-backup-export.test.ts name validation)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn error_of(name: &str) -> String {
        normalize_named_backup_file_name(name)
            .expect_err("should reject")
            .message()
            .to_string()
    }

    #[test]
    fn accepts_safe_names_and_appends_extension() {
        assert_eq!(normalize_named_backup_file_name("daily").unwrap(), "daily.json");
        assert_eq!(
            normalize_named_backup_file_name("  daily  ").unwrap(),
            "daily.json"
        );
        assert_eq!(
            normalize_named_backup_file_name("My_Backup-2").unwrap(),
            "My_Backup-2.json"
        );
        // One trailing .json (case-insensitive) is stripped, then re-added.
        assert_eq!(
            normalize_named_backup_file_name("daily.JSON").unwrap(),
            "daily.json"
        );
    }

    #[test]
    fn rejects_with_exact_error_strings() {
        assert_eq!(error_of(""), "Named backup requires a non-empty filename");
        assert_eq!(error_of("   "), "Named backup requires a non-empty filename");
        assert_eq!(
            error_of("a/b"),
            "Backup filename must not contain path separators"
        );
        assert_eq!(
            error_of("a\\b"),
            "Backup filename must not contain path separators"
        );
        assert_eq!(
            error_of("a..b"),
            "Backup filename must not contain traversal tokens"
        );
        assert_eq!(
            error_of("a.ROTATE.b"),
            "Backup filename may not contain rotation-style sequences"
        );
        assert_eq!(
            error_of(".json"),
            "Backup filename cannot be just an extension"
        );
        assert_eq!(
            error_of("a.tmp"),
            "Backup filename may not end with temporary suffixes"
        );
        assert_eq!(
            error_of("a.wal.json"),
            "Backup filename may not end with temporary suffixes"
        );
        assert_eq!(
            error_of("CON"),
            "Backup filename may not use a reserved Windows device name"
        );
        assert_eq!(
            error_of("com7"),
            "Backup filename may not use a reserved Windows device name"
        );
        assert_eq!(
            error_of("lpt1.json"),
            "Backup filename may not use a reserved Windows device name"
        );
        assert_eq!(
            error_of("has space"),
            "Backup filename may only contain letters, numbers, hyphens, and underscores; dots (.) are not allowed"
        );
        assert_eq!(
            error_of("dot.name"),
            "Backup filename may only contain letters, numbers, hyphens, and underscores; dots (.) are not allowed"
        );
    }

    #[test]
    fn com0_and_lpt0_are_not_reserved() {
        assert_eq!(normalize_named_backup_file_name("com0").unwrap(), "com0.json");
        assert_eq!(normalize_named_backup_file_name("lpt0").unwrap(), "lpt0.json");
        // com10 is not reserved either (regex is com[1-9] exactly).
        assert_eq!(
            normalize_named_backup_file_name("com10").unwrap(),
            "com10.json"
        );
    }

    #[test]
    fn path_relative_basics() {
        if cfg!(windows) {
            assert_eq!(path_relative("C:\\a\\b", "C:\\a\\b"), "");
            assert_eq!(path_relative("C:\\a", "C:\\a\\b\\c"), "b\\c");
            assert_eq!(path_relative("C:\\a\\b", "C:\\a"), "..");
            assert!(path_relative("C:\\a", "C:\\x\\y").starts_with(".."));
            // Case-insensitive comparison on Windows.
            assert_eq!(path_relative("C:\\A", "c:\\a\\b"), "b");
        } else {
            assert_eq!(path_relative("/a/b", "/a/b"), "");
            assert_eq!(path_relative("/a", "/a/b/c"), "b/c");
            assert_eq!(path_relative("/a/b", "/a"), "..");
            assert_eq!(path_relative("/a", "/x/y"), "../x/y");
        }
    }

    #[test]
    fn node_resolve_collapses_dots() {
        if cfg!(windows) {
            assert_eq!(node_resolve("C:\\a\\.\\b\\..\\c"), "C:\\a\\c");
        } else {
            assert_eq!(node_resolve("/a/./b/../c"), "/a/c");
        }
    }

    #[test]
    fn in_flight_set_round_trip() {
        let key = "test-key-in-flight";
        assert!(!in_flight_contains_or_insert(key));
        assert!(in_flight_contains_or_insert(key));
        in_flight_remove(key);
        assert!(!in_flight_contains_or_insert(key));
        in_flight_remove(key);
    }
}
