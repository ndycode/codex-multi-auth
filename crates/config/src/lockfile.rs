//! Port of the cross-process config-save lockfile from `lib/config.ts`
//! (spec 01 §4.5/§10.2).
//!
//! `with_config_file_lock(target, task)` acquires `<target>.lock` via
//! exclusive create (`wx`, mode 0600) writing a single-line JSON payload
//! `{"pid":…,"owner":"<uuid>","acquiredAt":…,"expiresAt":…}` + `"\n"`.
//!
//! - TTL 10 s; wait timeout 10 s; poll 50 ms.
//! - Stale detection: parsed finite `expiresAt` → stale iff `expiresAt <=
//!   now`; ENOENT → stale; unreadable/malformed → mtime heuristic
//!   (`now - mtime > 10_000` → stale; stat ENOENT → stale; other stat error →
//!   NOT stale).
//! - Stale locks are taken over (unlink with EBUSY/EPERM ×5 retry, failures
//!   swallowed) and the loop re-attempts immediately.
//! - Transient create errors (EBUSY/EPERM) before the deadline poll-retry;
//!   at the deadline a fresh foreign lock yields an `"ELOCKTIMEOUT"`-coded
//!   error with the frozen message.
//! - Release is OWNER-SAFE: the lockfile is re-read and left alone when it
//!   carries a different owner token (a stale takeover happened); ENOENT is
//!   done; an unreadable lockfile is best-effort unlinked anyway.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use cma_core::fs_retry::{Backoff, RetryOptions, code_of, io_error_with_code, with_retry};
use cma_core::json_io::{strip_utf8_bom, stringify_compact};
use cma_core::utils::{now_ms, sleep};

/// `CONFIG_LOCK_TTL_MS = 10_000`.
pub const CONFIG_LOCK_TTL_MS: i64 = 10_000;
/// `CONFIG_LOCK_WAIT_TIMEOUT_MS = 10_000`.
pub const CONFIG_LOCK_WAIT_TIMEOUT_MS: i64 = 10_000;
/// `CONFIG_LOCK_POLL_MS = 50`.
pub const CONFIG_LOCK_POLL_MS: u64 = 50;

const RETRYABLE_FS_CODES: &[&str] = &["EBUSY", "EPERM"];

/// The lock payload (serialized field order matches the TS object literal:
/// pid, owner, acquiredAt, expiresAt).
#[derive(Debug, Serialize)]
struct ConfigLockPayload<'a> {
    pid: u32,
    owner: &'a str,
    #[serde(rename = "acquiredAt")]
    acquired_at: i64,
    #[serde(rename = "expiresAt")]
    expires_at: i64,
}

/// `<target>.lock`.
pub fn config_lock_path_for(target_path: &Path) -> PathBuf {
    let mut os = target_path.as_os_str().to_os_string();
    os.push(".lock");
    PathBuf::from(os)
}

fn exponential_10ms() -> Backoff {
    Backoff::from_fn(|attempt| 10u64.saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1))))
}

/// Best-effort unlink with the EBUSY/EPERM ×5 retry; every failure swallowed
/// (a leftover lockfile is recovered as stale by the next acquirer).
async fn unlink_config_lock_with_retry(lock_path: &Path) {
    let _ = with_retry(
        || {
            let lock_path = lock_path.to_path_buf();
            async move { fs::remove_file(&lock_path) }
        },
        RetryOptions::<io::Error>::new(5, exponential_10ms()).with_codes(RETRYABLE_FS_CODES),
    )
    .await;
}

/// Owner-safe release: only unlink when the lockfile still carries OUR owner
/// token (or is unreadable/ownerless).
async fn release_config_lock_if_owner(lock_path: &Path, owner: &str) {
    match fs::read(lock_path) {
        Ok(bytes) => {
            let content = String::from_utf8_lossy(&bytes);
            if let Ok(parsed) = serde_json::from_str::<Value>(strip_utf8_bom(&content))
                && let Some(lock_owner) = parsed.get("owner").and_then(Value::as_str)
                && !lock_owner.is_empty()
                && lock_owner != owner
            {
                // Lock was taken over by another holder; leave their lock.
                return;
            }
            // Ours / ownerless / malformed → best-effort unlink.
        }
        Err(error) => {
            if error.kind() == io::ErrorKind::NotFound {
                return;
            }
            // Unreadable: fall through and attempt our best-effort unlink.
        }
    }
    unlink_config_lock_with_retry(lock_path).await;
}

/// `isConfigLockStale` — expiry-first, mtime-heuristic fallback.
async fn is_config_lock_stale(lock_path: &Path) -> bool {
    match fs::read(lock_path) {
        Ok(bytes) => {
            let content = String::from_utf8_lossy(&bytes);
            if let Ok(parsed) = serde_json::from_str::<Value>(strip_utf8_bom(&content))
                && let Some(expires_at) = parsed.get("expiresAt").and_then(Value::as_f64)
                && expires_at.is_finite()
            {
                return expires_at <= now_ms() as f64;
            }
            // Unreadable/malformed payload: fall through to the mtime heuristic.
        }
        Err(error) => {
            if error.kind() == io::ErrorKind::NotFound {
                return true;
            }
            // Fall through to the mtime heuristic.
        }
    }
    match cma_core::json_io::file_mtime_ms(lock_path) {
        Ok(Some(mtime_ms)) => (now_ms() as f64) - mtime_ms > CONFIG_LOCK_TTL_MS as f64,
        Ok(None) => true,
        Err(_) => false,
    }
}

/// Exclusive-create the lockfile (`wx`, 0600 on unix) and write the payload
/// line. Any error is returned for the caller's code-based dispatch.
fn try_create_lock(lock_path: &Path, owner: &str) -> io::Result<()> {
    let now = now_ms();
    let payload = ConfigLockPayload {
        pid: std::process::id(),
        owner,
        acquired_at: now,
        expires_at: now + CONFIG_LOCK_TTL_MS,
    };
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(lock_path)?;
    use std::io::Write;
    file.write_all(format!("{}\n", stringify_compact(&payload)).as_bytes())?;
    Ok(())
}

/// `withConfigFileLock(targetPath, task)` — see module docs. The task runs
/// with the lock held; release is owner-safe and always attempted.
///
/// Errors from acquisition surface as `io::Error`s converted through
/// `E::From<io::Error>`; the timeout error carries code `"ELOCKTIMEOUT"`
/// (recoverable via `cma_core::fs_retry::code_of`).
pub async fn with_config_file_lock<T, E, F, Fut>(target_path: &Path, task: F) -> Result<T, E>
where
    E: From<io::Error>,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    with_config_file_lock_timeout(target_path, CONFIG_LOCK_WAIT_TIMEOUT_MS, task).await
}

/// [`with_config_file_lock`] with an injectable wait timeout. The wall-clock
/// deadline cannot be faked (§8.5 — `now_ms()` parity with `Date.now()`), so
/// tests exercise the full wait/timeout path through this seam instead of the
/// production 10 s constant.
async fn with_config_file_lock_timeout<T, E, F, Fut>(
    target_path: &Path,
    wait_timeout_ms: i64,
    task: F,
) -> Result<T, E>
where
    E: From<io::Error>,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    let lock_path = config_lock_path_for(target_path);
    let owner = uuid::Uuid::new_v4().to_string();
    if let Some(parent) = lock_path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(E::from)?;
    }
    let deadline = now_ms() + wait_timeout_ms;
    loop {
        match try_create_lock(&lock_path, &owner) {
            Ok(()) => break,
            Err(error) => {
                let code = code_of(&error);
                if code != Some("EEXIST") {
                    // A transient FS lock on the lockfile itself: retry until
                    // the deadline; anything else propagates.
                    if code.is_some_and(|c| RETRYABLE_FS_CODES.contains(&c))
                        && now_ms() < deadline
                    {
                        sleep(CONFIG_LOCK_POLL_MS).await;
                        continue;
                    }
                    return Err(E::from(error));
                }
                // Lock is held. Take it over if the holder expired/crashed;
                // otherwise wait.
                if is_config_lock_stale(&lock_path).await {
                    unlink_config_lock_with_retry(&lock_path).await;
                    continue;
                }
                if now_ms() >= deadline {
                    return Err(E::from(io_error_with_code(
                        "ELOCKTIMEOUT",
                        format!(
                            "Timed out acquiring config save lock at {}.",
                            lock_path.display()
                        ),
                    )));
                }
                sleep(CONFIG_LOCK_POLL_MS).await;
            }
        }
    }
    let result = task().await;
    release_config_lock_if_owner(&lock_path, &owner).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tempdir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[tokio::test]
    async fn acquires_writes_payload_line_and_releases() {
        let dir = tempdir();
        let target = dir.path().join("config.json");
        let lock_path = config_lock_path_for(&target);

        let observed_lock = lock_path.clone();
        let result: Result<&str, io::Error> = with_config_file_lock(&target, || async move {
            let content = fs::read_to_string(&observed_lock).expect("lock exists during task");
            assert!(content.ends_with('\n'), "single line + newline");
            let parsed: Value = serde_json::from_str(content.trim_end()).unwrap();
            let keys: Vec<&str> = parsed.as_object().unwrap().keys().map(String::as_str).collect();
            assert_eq!(keys, vec!["pid", "owner", "acquiredAt", "expiresAt"]);
            assert_eq!(parsed["pid"], json!(std::process::id()));
            let acquired = parsed["acquiredAt"].as_i64().unwrap();
            let expires = parsed["expiresAt"].as_i64().unwrap();
            assert_eq!(expires - acquired, CONFIG_LOCK_TTL_MS);
            Ok("done")
        })
        .await;
        assert_eq!(result.unwrap(), "done");
        assert!(!lock_path.exists(), "lock released after the task");
    }

    #[tokio::test]
    async fn takes_over_a_stale_foreign_lock_and_removes_only_its_own() {
        // config-18: expired foreign lock is stolen; our release removes OUR
        // lock, not a hypothetical newer one.
        let dir = tempdir();
        let target = dir.path().join("config.json");
        let lock_path = config_lock_path_for(&target);
        let stale_payload = json!({
            "pid": 12345,
            "owner": "someone-else",
            "acquiredAt": now_ms() - 60_000,
            "expiresAt": now_ms() - 50_000,
        });
        fs::write(&lock_path, format!("{stale_payload}\n")).unwrap();

        let result: Result<(), io::Error> =
            with_config_file_lock(&target, || async { Ok(()) }).await;
        assert!(result.is_ok());
        assert!(!lock_path.exists());
    }

    #[tokio::test]
    async fn owner_safe_release_leaves_a_foreign_lock_in_place() {
        let dir = tempdir();
        let lock_path = dir.path().join("config.json.lock");
        fs::write(
            &lock_path,
            format!("{}\n", json!({ "owner": "other-owner", "expiresAt": now_ms() + 60_000 })),
        )
        .unwrap();
        release_config_lock_if_owner(&lock_path, "my-owner").await;
        assert!(lock_path.exists(), "foreign lock must not be deleted");

        // Ownerless / malformed lock IS unlinked.
        fs::write(&lock_path, "not json").unwrap();
        release_config_lock_if_owner(&lock_path, "my-owner").await;
        assert!(!lock_path.exists());
    }

    #[tokio::test]
    async fn staleness_rules_match_the_ts_matrix() {
        let dir = tempdir();
        let lock_path = dir.path().join("config.json.lock");

        // Missing → stale.
        assert!(is_config_lock_stale(&lock_path).await);

        // Fresh expiry → not stale.
        fs::write(
            &lock_path,
            format!("{}\n", json!({ "expiresAt": now_ms() + 60_000 })),
        )
        .unwrap();
        assert!(!is_config_lock_stale(&lock_path).await);

        // Expired → stale.
        fs::write(
            &lock_path,
            format!("{}\n", json!({ "expiresAt": now_ms() - 1_000 })),
        )
        .unwrap();
        assert!(is_config_lock_stale(&lock_path).await);

        // Malformed + fresh mtime → NOT stale (mtime heuristic).
        fs::write(&lock_path, "garbage").unwrap();
        assert!(!is_config_lock_stale(&lock_path).await);

        // BOM-prefixed payload parses (lockfile parse DOES strip BOM).
        fs::write(
            &lock_path,
            format!("\u{feff}{}\n", json!({ "expiresAt": now_ms() - 1 })),
        )
        .unwrap();
        assert!(is_config_lock_stale(&lock_path).await);
    }

    #[tokio::test]
    async fn serializes_two_contenders_in_process() {
        // The second acquirer sees a fresh lock and waits (poll 50 ms) until
        // release, then proceeds — no ELOCKTIMEOUT under normal handoff.
        let dir = tempdir();
        let target = dir.path().join("config.json");
        let marker = dir.path().join("order.txt");

        let target_a = target.clone();
        let marker_a = marker.clone();
        let first = tokio::spawn(async move {
            with_config_file_lock::<_, io::Error, _, _>(&target_a, || async move {
                cma_core::utils::sleep(120).await;
                fs::write(&marker_a, "first").unwrap();
                Ok(())
            })
            .await
        });
        // Give the first task time to grab the lock.
        cma_core::utils::sleep(30).await;
        let target_b = target.clone();
        let marker_b = marker.clone();
        let second = tokio::spawn(async move {
            with_config_file_lock::<_, io::Error, _, _>(&target_b, || async move {
                let previous = fs::read_to_string(&marker_b).unwrap_or_default();
                assert_eq!(previous, "first", "second holder runs after the first");
                Ok(())
            })
            .await
        });
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn waits_then_times_out_with_elocktimeout_against_a_live_foreign_lock() {
        // End-to-end timeout path: a FRESH foreign lock (far-future
        // `expiresAt`) is never taken over, the acquirer polls until the
        // deadline, and the frozen ELOCKTIMEOUT error surfaces. The wait
        // timeout is shortened through the internal seam because the
        // deadline is wall-clock (§8.5) and cannot be faked.
        let dir = tempdir();
        let target = dir.path().join("config.json");
        let lock_path = config_lock_path_for(&target);
        fs::write(
            &lock_path,
            format!(
                "{}\n",
                json!({
                    "pid": 999_999,
                    "owner": "foreign-owner",
                    "acquiredAt": now_ms(),
                    "expiresAt": now_ms() + 60_000,
                })
            ),
        )
        .unwrap();

        let task_ran = std::sync::atomic::AtomicBool::new(false);
        let started = now_ms();
        let result: Result<(), io::Error> =
            with_config_file_lock_timeout(&target, 250, || async {
                task_ran.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .await;
        let error = result.expect_err("a live foreign lock must time the acquirer out");
        assert_eq!(code_of(&error), Some("ELOCKTIMEOUT"));
        assert_eq!(
            error.to_string(),
            format!(
                "Timed out acquiring config save lock at {}.",
                lock_path.display()
            )
        );
        assert!(
            !task_ran.load(std::sync::atomic::Ordering::SeqCst),
            "task must never run while the foreign lock is held"
        );
        // The loop really waited through the poll cycle to the deadline.
        assert!(now_ms() - started >= 250);
        // Owner-safety: the foreign lock is left untouched (no takeover, no
        // release-unlink of someone else's lock).
        let remaining: Value =
            serde_json::from_str(fs::read_to_string(&lock_path).unwrap().trim()).unwrap();
        assert_eq!(remaining.get("owner"), Some(&json!("foreign-owner")));
    }

    #[test]
    fn frozen_timeout_message_shape() {
        let error = io_error_with_code(
            "ELOCKTIMEOUT",
            "Timed out acquiring config save lock at /tmp/x.lock.".to_string(),
        );
        assert_eq!(code_of(&error), Some("ELOCKTIMEOUT"));
        assert!(error.to_string().starts_with("Timed out acquiring config save lock at"));
    }
}
