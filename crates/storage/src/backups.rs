//! Port of the rotating-backup + discovery privates of `lib/storage.ts`:
//! `createRotatingAccountsBackup`, `cleanupStaleRotatingBackupArtifacts`,
//! `isRotatingBackupTempArtifact`,
//! `getAccountsBackupRecoveryCandidatesWithDiscovery`, plus the shared
//! copy/rename retry helpers.
//!
//! Behavior source: spec 02 §7.3–§7.5, gotchas 14 & 33.
//!
//! Exact timing: copy/rename retries are 5 attempts on a `10·2^(n-1)` ms
//! schedule (`BACKUP_COPY_MAX_ATTEMPTS` / `BACKUP_COPY_BASE_DELAY_MS`);
//! renames add 0–10 ms jitter; both use the DEFAULT transient-code set
//! (EBUSY/EPERM/EAGAIN/ENOTEMPTY/EACCES).

use std::fs;
use std::io;
use std::path::Path;

use cma_core::fs_retry::{Backoff, RetryOptions, code_of, with_retry};
use cma_core::logger::create_logger;
use cma_core::temp_path::temp_file_nonce;
use serde_json::json;

use crate::backup_paths::{
    ACCOUNTS_BACKUP_HISTORY_DEPTH, ACCOUNTS_BACKUP_SUFFIX, ACCOUNTS_WAL_SUFFIX,
    RESET_MARKER_SUFFIX, get_accounts_backup_recovery_candidates,
};
use crate::misc::is_cache_like_backup_artifact_name;

const BACKUP_COPY_MAX_ATTEMPTS: u32 = 5;
const BACKUP_COPY_BASE_DELAY_MS: u64 = 10;

fn backup_backoff() -> Backoff {
    Backoff::from_fn(|attempt| {
        BACKUP_COPY_BASE_DELAY_MS.saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1)))
    })
}

/// `copyFileWithRetry(source, destination, {allowMissingSource})`.
pub(crate) async fn copy_file_with_retry(
    source_path: &Path,
    destination_path: &Path,
    allow_missing_source: bool,
) -> io::Result<()> {
    let result = with_retry(
        || {
            let source = source_path.to_path_buf();
            let destination = destination_path.to_path_buf();
            async move { fs::copy(&source, &destination).map(|_| ()) }
        },
        RetryOptions::<io::Error>::new(BACKUP_COPY_MAX_ATTEMPTS, backup_backoff()),
    )
    .await;
    match result {
        Err(error) if allow_missing_source && code_of(&error) == Some("ENOENT") => Ok(()),
        other => other,
    }
}

/// `renameFileWithRetry(source, destination)` — same schedule + 0–10 ms
/// jitter.
pub(crate) async fn rename_file_with_retry(
    source_path: &Path,
    destination_path: &Path,
) -> io::Result<()> {
    with_retry(
        || {
            let source = source_path.to_path_buf();
            let destination = destination_path.to_path_buf();
            async move { fs::rename(&source, &destination) }
        },
        RetryOptions::<io::Error>::new(BACKUP_COPY_MAX_ATTEMPTS, backup_backoff())
            .with_jitter(BACKUP_COPY_BASE_DELAY_MS),
    )
    .await
}

/// `createRotatingAccountsBackup(path)` — stage-then-rename rotation of
/// `.bak` → `.bak.1` → `.bak.2` (spec 02 §7.3). The `latest` copy of the
/// LIVE file does NOT allow a missing source (throws); slot shifts do.
/// Staged files are best-effort cleaned in all cases.
pub async fn create_rotating_accounts_backup(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    let candidates = get_accounts_backup_recovery_candidates(path, ACCOUNTS_BACKUP_HISTORY_DEPTH);
    let rotation_nonce = temp_file_nonce();
    let mut staged_writes: Vec<(String, String)> = Vec::new(); // (target, staged)
    let build_staged_path =
        |target_path: &str, label: &str| format!("{target_path}.rotate.{rotation_nonce}.{label}.tmp");

    let result: io::Result<()> = async {
        for i in (1..candidates.len()).rev() {
            let previous_path = &candidates[i - 1];
            let current_path = &candidates[i];
            if !Path::new(previous_path).exists() {
                continue;
            }
            let staged_path = build_staged_path(current_path, &format!("slot-{i}"));
            copy_file_with_retry(Path::new(previous_path), Path::new(&staged_path), true).await?;
            if Path::new(&staged_path).exists() {
                staged_writes.push((current_path.clone(), staged_path));
            }
        }

        let Some(latest_backup_path) = candidates.first() else {
            return Ok(());
        };
        let latest_staged_path = build_staged_path(latest_backup_path, "latest");
        // Missing live source is NOT allowed here — it throws.
        copy_file_with_retry(path, Path::new(&latest_staged_path), false).await?;
        if Path::new(&latest_staged_path).exists() {
            staged_writes.push((latest_backup_path.clone(), latest_staged_path));
        }

        for (target_path, staged_path) in &staged_writes {
            rename_file_with_retry(Path::new(staged_path), Path::new(target_path)).await?;
        }
        Ok(())
    }
    .await;

    // `finally`: unlink any staged file that still exists (best effort).
    for (_, staged_path) in &staged_writes {
        if Path::new(staged_path).exists() {
            let _ = fs::remove_file(staged_path);
        }
    }
    result
}

/// `isRotatingBackupTempArtifact(storagePath, candidatePath)` — name starts
/// with `<path>.bak`, ends `.tmp`, contains `.rotate.`, and the segment
/// between `.bak` and `.rotate.` is empty or `^\.\d+$`.
pub(crate) fn is_rotating_backup_temp_artifact(
    storage_path: impl AsRef<Path>,
    candidate_path: &str,
) -> bool {
    let backup_prefix = format!(
        "{}{}",
        storage_path.as_ref().to_string_lossy(),
        ACCOUNTS_BACKUP_SUFFIX
    );
    if !candidate_path.starts_with(&backup_prefix) || !candidate_path.ends_with(".tmp") {
        return false;
    }
    let suffix = &candidate_path[backup_prefix.len()..];
    let Some(rotate_separator_index) = suffix.find(".rotate.") else {
        return false;
    };
    let backup_index_suffix = &suffix[..rotate_separator_index];
    if backup_index_suffix.is_empty() {
        return true;
    }
    // `^\.\d+$`
    let Some(digits) = backup_index_suffix.strip_prefix('.') else {
        return false;
    };
    !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
}

/// `cleanupStaleRotatingBackupArtifacts(path)` — runs at the START of every
/// `loadAccountsInternal`; deletes crashed-rotation staging files (gotcha 33:
/// they carry secrets). Failures are logged as warnings.
pub async fn cleanup_stale_rotating_backup_artifacts(path: impl AsRef<Path>) {
    let path = path.as_ref();
    let log = create_logger("storage");
    let directory_path = path.parent().unwrap_or_else(|| Path::new(""));
    let entries = match fs::read_dir(directory_path) {
        Ok(entries) => entries,
        Err(error) => {
            if code_of(&error) != Some("ENOENT") {
                log.warn(
                    "Failed to scan for stale rotating backup artifacts",
                    Some(&json!({
                        "path": path.to_string_lossy(),
                        "error": error.to_string(),
                    })),
                );
            }
            return;
        }
    };

    for entry in entries.flatten() {
        let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }
        let entry_path = directory_path
            .join(entry.file_name())
            .to_string_lossy()
            .into_owned();
        if !is_rotating_backup_temp_artifact(path, &entry_path) {
            continue;
        }
        if let Err(error) = fs::remove_file(&entry_path)
            && code_of(&error) != Some("ENOENT")
        {
            log.warn(
                "Failed to remove stale rotating backup artifact",
                Some(&json!({
                    "path": entry_path,
                    "error": error.to_string(),
                })),
            );
        }
    }
}

/// `getAccountsBackupRecoveryCandidatesWithDiscovery(path)` — the 3 known
/// rotation paths first, then discovered `basename(path).`-prefixed files
/// (excluding cache-like, `.reset-intent`, `.tmp`, `.rotate.`, `.wal`, and
/// already-known paths) sorted case-insensitively (gotcha 14).
pub async fn get_accounts_backup_recovery_candidates_with_discovery(
    path: impl AsRef<Path>,
) -> Vec<String> {
    let path = path.as_ref();
    let log = create_logger("storage");
    let known_candidates =
        get_accounts_backup_recovery_candidates(path, ACCOUNTS_BACKUP_HISTORY_DEPTH);
    let candidate_prefix = format!(
        "{}.",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    );
    let directory_path = path.parent().unwrap_or_else(|| Path::new(""));
    let mut discovered: Vec<String> = Vec::new();

    match fs::read_dir(directory_path) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
                if !is_file {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.starts_with(&candidate_prefix) {
                    continue;
                }
                if is_cache_like_backup_artifact_name(&name) {
                    continue;
                }
                if name.ends_with(RESET_MARKER_SUFFIX) {
                    continue;
                }
                if name.ends_with(".tmp") {
                    continue;
                }
                if name.contains(".rotate.") {
                    continue;
                }
                if name.ends_with(ACCOUNTS_WAL_SUFFIX) {
                    continue;
                }
                let candidate_path = directory_path
                    .join(&name)
                    .to_string_lossy()
                    .into_owned();
                if known_candidates.contains(&candidate_path) {
                    continue;
                }
                if !discovered.contains(&candidate_path) {
                    discovered.push(candidate_path);
                }
            }
        }
        Err(error) => {
            if code_of(&error) != Some("ENOENT") {
                log.warn(
                    "Failed to discover account backup candidates",
                    Some(&json!({
                        "path": path.to_string_lossy(),
                        "error": error.to_string(),
                    })),
                );
            }
        }
    }

    // `localeCompare(..., { sensitivity: "base" })` — case-insensitive
    // ordering; stable sort preserves insertion order for case-variant ties.
    discovered.sort_by_key(|p| p.to_lowercase());

    let mut result = known_candidates;
    result.extend(discovered);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotating_artifact_matcher_accepts_bak_and_indexed_bak_staging_names() {
        let storage = "/x/a.json";
        assert!(is_rotating_backup_temp_artifact(
            storage,
            "/x/a.json.bak.rotate.123.4.abcd1234.latest.tmp"
        ));
        assert!(is_rotating_backup_temp_artifact(
            storage,
            "/x/a.json.bak.2.rotate.123.4.abcd1234.slot-2.tmp"
        ));
        // No .rotate. segment.
        assert!(!is_rotating_backup_temp_artifact(storage, "/x/a.json.bak.tmp"));
        // Non-numeric index segment between .bak and .rotate.
        assert!(!is_rotating_backup_temp_artifact(
            storage,
            "/x/a.json.bak.evil.rotate.1.tmp"
        ));
        // Wrong extension.
        assert!(!is_rotating_backup_temp_artifact(
            storage,
            "/x/a.json.bak.rotate.1.json"
        ));
        // Different file entirely.
        assert!(!is_rotating_backup_temp_artifact(
            storage,
            "/x/b.json.bak.rotate.1.tmp"
        ));
    }

    #[tokio::test]
    async fn rotation_shifts_history_and_copies_the_live_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        let bak = dir.path().join("a.json.bak");
        let bak1 = dir.path().join("a.json.bak.1");
        let bak2 = dir.path().join("a.json.bak.2");
        fs::write(&path, "live-v3").unwrap();
        fs::write(&bak, "old-v2").unwrap();
        fs::write(&bak1, "old-v1").unwrap();
        create_rotating_accounts_backup(&path).await.unwrap();
        assert_eq!(fs::read_to_string(&bak).unwrap(), "live-v3");
        assert_eq!(fs::read_to_string(&bak1).unwrap(), "old-v2");
        assert_eq!(fs::read_to_string(&bak2).unwrap(), "old-v1");
        // No staging leftovers.
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".rotate."))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[tokio::test]
    async fn rotation_fails_when_the_live_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        let error = create_rotating_accounts_backup(&path).await.unwrap_err();
        assert_eq!(code_of(&error), Some("ENOENT"));
    }

    #[tokio::test]
    async fn stale_artifact_cleanup_removes_only_matching_staging_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        let stale = dir.path().join("a.json.bak.rotate.1.2.abcd.latest.tmp");
        let stale_indexed = dir.path().join("a.json.bak.1.rotate.9.9.beef.slot-1.tmp");
        let unrelated = dir.path().join("a.json.bak");
        fs::write(&stale, "x").unwrap();
        fs::write(&stale_indexed, "x").unwrap();
        fs::write(&unrelated, "x").unwrap();
        cleanup_stale_rotating_backup_artifacts(&path).await;
        assert!(!stale.exists());
        assert!(!stale_indexed.exists());
        assert!(unrelated.exists());
    }

    #[tokio::test]
    async fn discovery_appends_filtered_candidates_after_the_known_three() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        fs::write(dir.path().join("a.json.bak"), "x").unwrap(); // known
        fs::write(dir.path().join("a.json.Backup"), "x").unwrap(); // discovered
        fs::write(dir.path().join("a.json.2024"), "x").unwrap(); // discovered
        fs::write(dir.path().join("a.json.cache.old"), "x").unwrap(); // cache-like
        fs::write(dir.path().join("a.json.reset-intent"), "x").unwrap(); // marker
        fs::write(dir.path().join("a.json.save.tmp"), "x").unwrap(); // tmp
        fs::write(dir.path().join("a.json.bak.rotate.1.tmp"), "x").unwrap(); // rotate+tmp
        fs::write(dir.path().join("a.json.wal"), "x").unwrap(); // wal
        fs::write(dir.path().join("other.json.bak"), "x").unwrap(); // different prefix
        let candidates = get_accounts_backup_recovery_candidates_with_discovery(&path).await;
        let to_s = |p: std::path::PathBuf| p.to_string_lossy().into_owned();
        assert_eq!(
            candidates,
            vec![
                format!("{}.bak", path.to_string_lossy()),
                format!("{}.bak.1", path.to_string_lossy()),
                format!("{}.bak.2", path.to_string_lossy()),
                // discovered, case-insensitive sort: "2024" < "backup"
                to_s(dir.path().join("a.json.2024")),
                to_s(dir.path().join("a.json.Backup")),
            ]
        );
    }

    #[tokio::test]
    async fn discovery_of_a_missing_directory_is_silent_and_returns_known_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nope").join("a.json");
        let candidates = get_accounts_backup_recovery_candidates_with_discovery(&path).await;
        assert_eq!(candidates.len(), 3);
    }
}
