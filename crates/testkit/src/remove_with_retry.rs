//! Windows-safe removal with retry — Rust port of `test/helpers/remove-with-retry.ts`
//! (spec 14 §11, harness invariant 3: Windows cleanup always via `removeWithRetry`
//! — never bare `rm`).
//!
//! On Windows, deleting files that another process (antivirus, indexer, a
//! just-exited child) still holds open fails transiently with sharing/permission
//! errors. The TS helper retries exactly this class of failures:
//!
//! - retryable codes: `EBUSY`, `EPERM`, `ENOTEMPTY`, `EACCES`
//! - `ENOENT` is success (the target is already gone)
//! - 6 attempts total, sleeping `25 * 2^attempt` ms between failures
//!   (25, 50, 100, 200, 400 ms; the 6th failure propagates)
//! - any other error propagates immediately
//!
//! This port is deliberately self-contained (like the TS helper, which does NOT
//! use `lib/fs-retry.ts`): it carries its own `io::Error` → errno-code mapping so
//! the testkit stays dependency-light and usable while `cma-core` is still being
//! ported. Feature code must keep using `cma_core::fs_retry` (ARCHITECTURE.md §8.2).

use std::fs;
use std::io;
use std::path::Path;
use std::thread;
use std::time::Duration;

/// Error codes the removal loop retries — mirrors `RETRYABLE_REMOVE_CODES` in the
/// TS helper exactly.
pub const RETRYABLE_REMOVE_CODES: [&str; 4] = ["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"];

/// Total attempts (TS: `for (let attempt = 0; attempt < 6; ...)`).
const MAX_ATTEMPTS: u32 = 6;

/// Base backoff in milliseconds (TS: `25 * 2 ** attempt`).
const BASE_DELAY_MS: u64 = 25;

/// Options mirroring Node's `fs.rm(path, { recursive, force })` shape used by the
/// TS helper.
///
/// - `recursive`: remove directories and their contents; without it, directories
///   are refused (Node `ERR_FS_EISDIR` parity — a non-retryable error).
/// - `force`: kept for signature parity. The helper always treats `ENOENT` as
///   success (the TS helper returns on `ENOENT` before consulting `force`), so
///   the flag has no additional effect here — exactly as in the TS helper.
#[derive(Debug, Clone, Copy, Default)]
pub struct RemoveOptions {
    pub recursive: bool,
    pub force: bool,
}

impl RemoveOptions {
    /// `{ recursive: true, force: true }` — the ubiquitous test-cleanup shape.
    pub const fn recursive_force() -> Self {
        Self {
            recursive: true,
            force: true,
        }
    }
}

/// Remove `target_path` (file, symlink, or — with `recursive` — a directory tree),
/// retrying transient Windows sharing/permission failures.
///
/// Behavior is a 1:1 port of `removeWithRetry` from `test/helpers/remove-with-retry.ts`:
/// `ENOENT` returns `Ok(())`; codes in [`RETRYABLE_REMOVE_CODES`] are retried up to
/// 6 attempts with `25 * 2^attempt` ms sleeps; everything else (and the final
/// failed attempt) returns the error.
pub fn remove_with_retry(
    target_path: impl AsRef<Path>,
    options: RemoveOptions,
) -> io::Result<()> {
    let target_path = target_path.as_ref();
    for attempt in 0..MAX_ATTEMPTS {
        match attempt_remove(target_path, options) {
            Ok(()) => return Ok(()),
            Err(error) => {
                if is_not_found(&error) {
                    return Ok(());
                }
                let retryable = matches!(
                    code_of(&error),
                    Some(code) if RETRYABLE_REMOVE_CODES.contains(&code)
                );
                if !retryable || attempt == MAX_ATTEMPTS - 1 {
                    return Err(error);
                }
                thread::sleep(Duration::from_millis(BASE_DELAY_MS << attempt));
            }
        }
    }
    unreachable!("remove_with_retry: the loop returns on every path")
}

/// Convenience wrapper: `remove_with_retry(path, { recursive: true, force: true })` —
/// what nearly every test cleanup site wants.
pub fn remove_recursive_with_retry(target_path: impl AsRef<Path>) -> io::Result<()> {
    remove_with_retry(target_path, RemoveOptions::recursive_force())
}

/// One removal attempt, dispatched on the target's (non-followed) file type so
/// symlinks are removed as links, never traversed (Node `fs.rm` parity).
fn attempt_remove(path: &Path, options: RemoveOptions) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return remove_symlink(path);
    }
    if file_type.is_dir() {
        if options.recursive {
            fs::remove_dir_all(path)
        } else {
            // Node: fs.rm(dir, { recursive: false }) → ERR_FS_EISDIR. Not in the
            // retry set, so it propagates immediately.
            Err(io::Error::new(
                io::ErrorKind::IsADirectory,
                format!(
                    "Path is a directory: {} (pass RemoveOptions {{ recursive: true, .. }}; Node ERR_FS_EISDIR parity)",
                    path.display()
                ),
            ))
        }
    } else {
        fs::remove_file(path)
    }
}

#[cfg(windows)]
fn remove_symlink(path: &Path) -> io::Result<()> {
    // Windows directory symlinks/junctions must be removed with remove_dir;
    // file symlinks with remove_file. Try file-first, preserving the original
    // error when both fail.
    fs::remove_file(path).or_else(|file_error| fs::remove_dir(path).map_err(|_| file_error))
}

#[cfg(not(windows))]
fn remove_symlink(path: &Path) -> io::Result<()> {
    fs::remove_file(path)
}

/// Map an `io::Error` to a Node-style errno code string, covering the codes the
/// removal loop cares about (`ENOENT` + [`RETRYABLE_REMOVE_CODES`]).
///
/// Raw OS codes are consulted first (they disambiguate `EPERM` vs `EACCES`,
/// which both surface as `ErrorKind::PermissionDenied`), then stable
/// `ErrorKind`s as a fallback. Windows raw-code mapping follows ARCHITECTURE.md
/// §8.2: `ERROR_SHARING_VIOLATION`/`ERROR_LOCK_VIOLATION` → `EBUSY`,
/// `ERROR_ACCESS_DENIED` → `EPERM`, `ERROR_DIR_NOT_EMPTY` → `ENOTEMPTY`.
pub fn code_of(error: &io::Error) -> Option<&'static str> {
    if let Some(raw) = error.raw_os_error()
        && let Some(code) = raw_code(raw)
    {
        return Some(code);
    }
    match error.kind() {
        io::ErrorKind::NotFound => Some("ENOENT"),
        io::ErrorKind::PermissionDenied => {
            Some(if cfg!(windows) { "EPERM" } else { "EACCES" })
        }
        io::ErrorKind::DirectoryNotEmpty => Some("ENOTEMPTY"),
        io::ErrorKind::ResourceBusy => Some("EBUSY"),
        _ => None,
    }
}

#[cfg(windows)]
fn raw_code(raw: i32) -> Option<&'static str> {
    match raw {
        2 | 3 => Some("ENOENT"),   // ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND
        5 => Some("EPERM"),        // ERROR_ACCESS_DENIED (§8.2 mapping)
        32 | 33 => Some("EBUSY"),  // ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION
        145 => Some("ENOTEMPTY"),  // ERROR_DIR_NOT_EMPTY
        _ => None,
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
const ENOTEMPTY_RAW: i32 = 39;
#[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
const ENOTEMPTY_RAW: i32 = 66; // macOS / BSDs

#[cfg(unix)]
fn raw_code(raw: i32) -> Option<&'static str> {
    match raw {
        1 => Some("EPERM"),
        2 => Some("ENOENT"),
        13 => Some("EACCES"),
        16 => Some("EBUSY"),
        code if code == ENOTEMPTY_RAW => Some("ENOTEMPTY"),
        _ => None,
    }
}

#[cfg(not(any(unix, windows)))]
fn raw_code(_raw: i32) -> Option<&'static str> {
    None
}

fn is_not_found(error: &io::Error) -> bool {
    matches!(code_of(error), Some("ENOENT"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_nested_directory_tree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("tree");
        fs::create_dir_all(root.join("a").join("b")).unwrap();
        fs::write(root.join("a").join("b").join("file.txt"), b"x").unwrap();
        fs::write(root.join("top.txt"), b"y").unwrap();

        remove_with_retry(&root, RemoveOptions::recursive_force()).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn missing_path_is_success() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        remove_with_retry(&missing, RemoveOptions::recursive_force()).unwrap();
        remove_with_retry(
            &missing,
            RemoveOptions {
                recursive: false,
                force: false,
            },
        )
        .unwrap();
    }

    #[test]
    fn removes_single_file_without_recursive() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file.txt");
        fs::write(&file, b"contents").unwrap();
        remove_with_retry(
            &file,
            RemoveOptions {
                recursive: false,
                force: false,
            },
        )
        .unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn non_recursive_on_directory_errors_immediately() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        let started = std::time::Instant::now();
        let error = remove_with_retry(
            &sub,
            RemoveOptions {
                recursive: false,
                force: false,
            },
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::IsADirectory);
        assert!(sub.exists());
        // EISDIR is not retryable — must not have gone through backoff sleeps.
        assert!(
            started.elapsed() < Duration::from_millis(BASE_DELAY_MS),
            "non-retryable errors must propagate without sleeping"
        );
    }

    #[cfg(unix)]
    #[test]
    fn removes_symlink_not_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.txt");
        fs::write(&target, b"kept").unwrap();
        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        remove_with_retry(
            &link,
            RemoveOptions {
                recursive: false,
                force: true,
            },
        )
        .unwrap();
        assert!(!link.exists());
        assert!(target.exists(), "symlink target must survive");
    }

    #[test]
    fn code_of_maps_stable_error_kinds() {
        assert_eq!(
            code_of(&io::Error::from(io::ErrorKind::NotFound)),
            Some("ENOENT")
        );
        assert_eq!(
            code_of(&io::Error::from(io::ErrorKind::DirectoryNotEmpty)),
            Some("ENOTEMPTY")
        );
        assert_eq!(
            code_of(&io::Error::from(io::ErrorKind::ResourceBusy)),
            Some("EBUSY")
        );
        let permission_expected = if cfg!(windows) { "EPERM" } else { "EACCES" };
        assert_eq!(
            code_of(&io::Error::from(io::ErrorKind::PermissionDenied)),
            Some(permission_expected)
        );
        assert_eq!(code_of(&io::Error::from(io::ErrorKind::TimedOut)), None);
    }

    #[cfg(windows)]
    #[test]
    fn code_of_maps_windows_raw_codes() {
        assert_eq!(code_of(&io::Error::from_raw_os_error(2)), Some("ENOENT"));
        assert_eq!(code_of(&io::Error::from_raw_os_error(3)), Some("ENOENT"));
        assert_eq!(code_of(&io::Error::from_raw_os_error(5)), Some("EPERM"));
        assert_eq!(code_of(&io::Error::from_raw_os_error(32)), Some("EBUSY"));
        assert_eq!(code_of(&io::Error::from_raw_os_error(33)), Some("EBUSY"));
        assert_eq!(
            code_of(&io::Error::from_raw_os_error(145)),
            Some("ENOTEMPTY")
        );
    }

    #[cfg(unix)]
    #[test]
    fn code_of_maps_unix_raw_codes() {
        assert_eq!(code_of(&io::Error::from_raw_os_error(1)), Some("EPERM"));
        assert_eq!(code_of(&io::Error::from_raw_os_error(2)), Some("ENOENT"));
        assert_eq!(code_of(&io::Error::from_raw_os_error(13)), Some("EACCES"));
        assert_eq!(code_of(&io::Error::from_raw_os_error(16)), Some("EBUSY"));
        assert_eq!(
            code_of(&io::Error::from_raw_os_error(ENOTEMPTY_RAW)),
            Some("ENOTEMPTY")
        );
    }

    /// The real Windows scenario: a file held open without share-delete access.
    /// The helper must burn through all six attempts (25+50+100+200+400 ms of
    /// backoff) before surfacing the retryable error, and succeed once the
    /// handle is released.
    #[cfg(windows)]
    #[test]
    fn retries_locked_file_then_errors_and_succeeds_after_release() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("locked.txt");
        fs::write(&file, b"locked").unwrap();
        let handle = fs::OpenOptions::new()
            .read(true)
            .share_mode(0) // deny all sharing, including FILE_SHARE_DELETE
            .open(&file)
            .unwrap();

        let started = std::time::Instant::now();
        let error = remove_with_retry(
            &file,
            RemoveOptions {
                recursive: false,
                force: true,
            },
        )
        .unwrap_err();
        let code = code_of(&error);
        assert!(
            matches!(code, Some("EBUSY") | Some("EPERM")),
            "expected a retryable sharing/permission code, got {code:?} ({error})"
        );
        assert!(
            started.elapsed() >= Duration::from_millis(700),
            "expected the full backoff schedule (25+50+100+200+400 ms), took {:?}",
            started.elapsed()
        );

        drop(handle);
        remove_with_retry(
            &file,
            RemoveOptions {
                recursive: false,
                force: true,
            },
        )
        .unwrap();
        assert!(!file.exists());
    }
}
