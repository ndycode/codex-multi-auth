//! Port of the small storage utility modules:
//! `lib/storage/record-utils.ts` (`isRecord`), `lib/storage/hash.ts`
//! (`computeSha256`), `lib/storage/cache-artifacts.ts`
//! (`isCacheLikeBackupArtifactName`), `lib/storage/gitignore.ts`
//! (`ensureCodexGitignoreEntry`), `lib/storage/error-hints.ts`
//! (`formatStorageErrorHint`, `toStorageError`) and
//! `lib/storage/account-persistence.ts` (`cloneAccountStorageForPersistence`).
//!
//! Behavior source: spec 02 §3.9, §17; hint strings are FROZEN.
//!
//! (`clampIndex` from record-utils.ts lives in `crate::matching` per the
//! ARCHITECTURE §6.3 surface split.)

use std::io;
use std::path::{Path, PathBuf};

use cma_core::errors::CodexError;
use cma_core::fs_retry::code_of;
use cma_core::logger::create_logger;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::public_types::{AccountStorageV3, ActiveIndexByFamily};

/// `isRecord(value)` — true for a JSON object (not array, not null).
pub fn is_record(value: &Value) -> bool {
    cma_core::utils::is_record(value)
}

/// `computeSha256(value)` — lowercase sha256 hex of the UTF-8 bytes.
pub fn compute_sha256(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// `isCacheLikeBackupArtifactName(name)` — lowercased name contains
/// `".cache"`.
pub fn is_cache_like_backup_artifact_name(entry_name: &str) -> bool {
    entry_name.to_lowercase().contains(".cache")
}

// ---------------------------------------------------------------------------
// .gitignore side-effect (spec 02 §3.9)
// ---------------------------------------------------------------------------

/// `ensureCodexGitignoreEntry` — when a candidate project root (the explicit
/// `currentProjectRoot`, else the storage dir's grandparent) contains `.git`,
/// append `".codex/\n"` to its `.gitignore` unless one of the four accepted
/// forms is already present. Failures are logged as warnings, never fatal.
pub async fn ensure_codex_gitignore_entry(storage_path: &Path, current_project_root: Option<&Path>) {
    let log = create_logger("storage");
    let config_dir = storage_path.parent().map(Path::to_path_buf);
    let inferred_project_root = config_dir.as_deref().and_then(Path::parent).map(Path::to_path_buf);

    let candidate_roots: Vec<PathBuf> = [
        current_project_root.map(Path::to_path_buf),
        inferred_project_root,
    ]
    .into_iter()
    .flatten()
    .filter(|root| !root.as_os_str().is_empty())
    .collect();

    let Some(project_root) = candidate_roots
        .into_iter()
        .find(|root| root.join(".git").exists())
    else {
        return;
    };

    let gitignore_path = project_root.join(".gitignore");
    let result: io::Result<()> = (|| {
        let mut content = String::new();
        if gitignore_path.exists() {
            let bytes = std::fs::read(&gitignore_path)?;
            content = String::from_utf8_lossy(&bytes).into_owned();
            let has_entry = content.split('\n').map(str::trim).any(|line| {
                line == ".codex" || line == ".codex/" || line == "/.codex" || line == "/.codex/"
            });
            if has_entry {
                return Ok(());
            }
        }
        let new_content = if content.ends_with('\n') || content.is_empty() {
            content
        } else {
            format!("{content}\n")
        };
        std::fs::write(&gitignore_path, format!("{new_content}.codex/\n"))?;
        log.debug(
            "Added .codex to .gitignore",
            Some(&json!({ "path": gitignore_path.to_string_lossy() })),
        );
        Ok(())
    })();
    if let Err(error) = result {
        log.warn(
            "Failed to update .gitignore",
            Some(&json!({ "error": error.to_string() })),
        );
    }
}

// ---------------------------------------------------------------------------
// Error hints (spec 02 §17 — strings FROZEN)
// ---------------------------------------------------------------------------

/// The errno-code half of `formatStorageErrorHint` — the TS helper switches
/// on `error.code || "UNKNOWN"`.
pub fn format_storage_error_hint_for_code(code: Option<&str>, path: &str) -> String {
    let is_windows = cfg!(windows);
    match code.unwrap_or("UNKNOWN") {
        "EACCES" | "EPERM" => {
            if is_windows {
                format!(
                    "Permission denied writing to {path}. Check antivirus exclusions for this folder. Ensure you have write permissions."
                )
            } else {
                format!(
                    "Permission denied writing to {path}. Check folder permissions. Try: chmod 755 ~/.codex"
                )
            }
        }
        "EBUSY" => format!(
            "File is locked at {path}. The file may be open in another program. Close any editors or processes accessing it."
        ),
        "ENOENT" => format!("Path does not exist: {path}. Create the parent folder and try again."),
        "ENOSPC" => format!("Disk is full. Free up space and try again. Path: {path}"),
        _ => {
            if is_windows {
                format!(
                    "Failed to write to {path}. Check folder permissions and ensure path contains no special characters."
                )
            } else {
                format!("Failed to write to {path}. Check folder permissions and disk space.")
            }
        }
    }
}

/// `formatStorageErrorHint(error, path)` for `io::Error`s (code extracted via
/// the shared errno shim).
pub fn format_storage_error_hint(error: &io::Error, path: &str) -> String {
    format_storage_error_hint_for_code(code_of(error), path)
}

/// `toStorageError(message, error, path)` — wrap an arbitrary storage failure
/// in a `StorageError` with a derived hint (`code = error.code || "UNKNOWN"`).
pub fn to_storage_error(message: impl Into<String>, error: io::Error, path: &str) -> CodexError {
    let code = code_of(&error).unwrap_or("UNKNOWN").to_string();
    let hint = format_storage_error_hint(&error, path);
    CodexError::storage(message, code, path, hint, Some(Box::new(error)))
}

// ---------------------------------------------------------------------------
// Persistence clone (account-persistence.ts)
// ---------------------------------------------------------------------------

/// `cloneAccountStorageForPersistence(storage)` — deep clone used by the
/// combined account+flagged transaction rollback path. Always yields
/// `version: 3`, cloned accounts, a finite `activeIndex` (else 0), an
/// `activeIndexByFamily` object (empty when missing — the TS built `{}`), and
/// preserves the manual pin (#474) / affinity generation when numeric.
pub fn clone_account_storage_for_persistence(
    storage: Option<&AccountStorageV3>,
) -> AccountStorageV3 {
    let mut cloned = AccountStorageV3::empty();
    if let Some(storage) = storage {
        cloned.accounts = storage.accounts.clone();
        // i64 is always finite; the TS finite check only guarded NaN floats.
        cloned.active_index = storage.active_index;
        cloned.active_index_by_family = Some(
            storage
                .active_index_by_family
                .clone()
                .unwrap_or_else(ActiveIndexByFamily::default),
        );
        cloned.pinned_account_index = storage.pinned_account_index;
        cloned.affinity_generation = storage.affinity_generation;
    } else {
        cloned.active_index_by_family = Some(ActiveIndexByFamily::default());
    }
    cloned
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::public_types::AccountMetadataV3;

    #[test]
    fn compute_sha256_matches_known_vector() {
        // echo -n "hello" | sha256sum
        assert_eq!(
            compute_sha256("hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(
            compute_sha256(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn cache_like_names_are_detected_case_insensitively() {
        assert!(is_cache_like_backup_artifact_name("a.json.CACHE.bak".to_lowercase().as_str()));
        assert!(is_cache_like_backup_artifact_name("accounts.json.Cache"));
        assert!(is_cache_like_backup_artifact_name("x.cache.1"));
        assert!(!is_cache_like_backup_artifact_name("accounts.json.bak"));
        assert!(!is_cache_like_backup_artifact_name("cachefile.json"));
    }

    #[test]
    fn is_record_only_accepts_objects() {
        assert!(is_record(&json!({})));
        assert!(!is_record(&json!([])));
        assert!(!is_record(&json!(null)));
        assert!(!is_record(&json!("x")));
    }

    #[test]
    fn hint_strings_are_frozen_per_code() {
        let p = "/x/accounts.json";
        let perm = format_storage_error_hint_for_code(Some("EPERM"), p);
        if cfg!(windows) {
            assert_eq!(
                perm,
                format!(
                    "Permission denied writing to {p}. Check antivirus exclusions for this folder. Ensure you have write permissions."
                )
            );
        } else {
            assert_eq!(
                perm,
                format!(
                    "Permission denied writing to {p}. Check folder permissions. Try: chmod 755 ~/.codex"
                )
            );
        }
        assert_eq!(
            format_storage_error_hint_for_code(Some("EACCES"), p),
            perm,
            "EACCES and EPERM share the hint"
        );
        assert_eq!(
            format_storage_error_hint_for_code(Some("EBUSY"), p),
            format!(
                "File is locked at {p}. The file may be open in another program. Close any editors or processes accessing it."
            )
        );
        assert_eq!(
            format_storage_error_hint_for_code(Some("ENOENT"), p),
            format!("Path does not exist: {p}. Create the parent folder and try again.")
        );
        assert_eq!(
            format_storage_error_hint_for_code(Some("ENOSPC"), p),
            format!("Disk is full. Free up space and try again. Path: {p}")
        );
        let fallback = format_storage_error_hint_for_code(None, p);
        if cfg!(windows) {
            assert_eq!(
                fallback,
                format!(
                    "Failed to write to {p}. Check folder permissions and ensure path contains no special characters."
                )
            );
        } else {
            assert_eq!(
                fallback,
                format!("Failed to write to {p}. Check folder permissions and disk space.")
            );
        }
        // Unrecognized codes fall through to the default branch too.
        assert_eq!(format_storage_error_hint_for_code(Some("EINVALID"), p), fallback);
    }

    #[test]
    fn to_storage_error_extracts_code_and_hint() {
        let error = cma_core::fs_retry::io_error_with_code("EBUSY", "locked");
        let wrapped = to_storage_error("Failed to save accounts: locked", error, "/x/a.json");
        assert_eq!(wrapped.code(), "EBUSY");
        assert_eq!(wrapped.message(), "Failed to save accounts: locked");
        assert_eq!(wrapped.path(), Some("/x/a.json"));
        assert!(wrapped.hint().unwrap().contains("File is locked at /x/a.json"));
    }

    #[test]
    fn clone_for_persistence_preserves_pin_and_generation() {
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(AccountMetadataV3::new("rt", 1, 2));
        storage.active_index = 1;
        storage.pinned_account_index = Some(1);
        storage.affinity_generation = Some(7);
        let cloned = clone_account_storage_for_persistence(Some(&storage));
        assert_eq!(cloned.accounts.len(), 1);
        assert_eq!(cloned.active_index, 1);
        assert_eq!(cloned.pinned_account_index, Some(1));
        assert_eq!(cloned.affinity_generation, Some(7));
        // Missing family map becomes an (empty) object — TS built `{}`.
        assert!(cloned.active_index_by_family.is_some());
    }

    #[test]
    fn clone_for_persistence_defaults_on_none() {
        let cloned = clone_account_storage_for_persistence(None);
        assert!(cloned.accounts.is_empty());
        assert_eq!(cloned.active_index, 0);
        assert_eq!(cloned.pinned_account_index, None);
        assert_eq!(cloned.affinity_generation, None);
        assert!(cloned.active_index_by_family.is_some());
    }
}
