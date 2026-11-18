//! Port of `lib/refresh-lease.ts` — cross-**process** refresh lease.
//!
//! Behavior source: specs/04-rotation.md §5.
//!
//! Prevents two processes from concurrently refreshing the same OAuth refresh
//! token (OpenAI rotates the token on first use ⇒ the second refresh gets
//! `invalid_grant`). The mutual-exclusion primitive is O_CREAT|O_EXCL on
//! `<leaseDir>/<sha256(token)>.lock` (0600 under a 0700 dir); ownership is a
//! per-owner uuid nonce (stress audit H2); successful refresh results are
//! cached in `<sha256>.result.json` for `resultTtlMs` so followers reuse them.
//!
//! On-disk formats are byte-compatible with TS: single-line compact JSON plus
//! a trailing `\n` (`{"tokenHash":…,"pid":…,"acquiredAt":…,"expiresAt":…,"nonce":…}`
//! and `{"tokenHash":…,"createdAt":…,"result":{…}}`).

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use cma_core::env_parsing::parse_boolean_env;
use cma_core::fs_retry::code_of;
use cma_core::json_io::stringify_compact;
use cma_core::logger::{ScopedLogger, create_logger};
use cma_core::runtime_paths::get_codex_multi_auth_dir;
use cma_core::schemas::parse::safe_parse_token_result;
use cma_core::schemas::token::TokenResult;
use cma_core::utils::{is_record, now_ms, sleep};

fn log() -> ScopedLogger {
    create_logger("refresh-lease")
}

const DEFAULT_LEASE_TTL_MS: i64 = 30_000;
/// Exported so the refresh queue can size its acquire-stage eviction threshold
/// above the maximum time a lease `acquire()` may legitimately block waiting.
pub const DEFAULT_WAIT_TIMEOUT_MS: i64 = 35_000;
const DEFAULT_POLL_INTERVAL_MS: i64 = 150;
const DEFAULT_RESULT_TTL_MS: i64 = 20_000;
const RETRYABLE_IO_ERRORS: [&str; 4] = ["EBUSY", "EPERM", "EMFILE", "ENFILE"];

/// Parsed `LeaseFilePayload` (lock file).
#[derive(Clone, Debug, PartialEq)]
struct LeaseFilePayload {
    token_hash: String,
    #[allow(dead_code)]
    pid: i64,
    #[allow(dead_code)]
    acquired_at: i64,
    expires_at: i64,
    /// Per-owner identity; `""` for locks written before H2 (best-effort
    /// unlink fallback on release).
    nonce: String,
}

/// Injectable fs operations (the TS `fsOps` seam). Sync methods — every
/// underlying operation is a small local file op; async-ness in the
/// coordinator comes only from the poll sleeps.
pub trait LeaseFs: Send + Sync {
    /// `mkdir(dir, { recursive: true, mode })` — succeeds when the dir exists.
    fn mkdir_recursive(&self, dir: &Path, mode: u32) -> io::Result<()>;
    /// Best-effort `chmod` (POSIX hardening; no-op impls are fine). Return
    /// `false` from [`LeaseFs::has_chmod`] to model a fsOps without `chmod`.
    fn chmod(&self, path: &Path, mode: u32) -> io::Result<()>;
    fn has_chmod(&self) -> bool {
        true
    }
    /// `open(path, "wx", mode)` + write `contents` through the handle. MUST
    /// fail with an `EEXIST`-coded error when the file already exists.
    fn open_excl_write(&self, path: &Path, contents: &str, mode: u32) -> io::Result<()>;
    /// `writeFile(path, contents, { mode })` (create/truncate).
    fn write_file(&self, path: &Path, contents: &str, mode: u32) -> io::Result<()>;
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    fn unlink(&self, path: &Path) -> io::Result<()>;
    fn read_to_string(&self, path: &Path) -> io::Result<String>;
    /// `stat(path).mtimeMs`.
    fn mtime_ms(&self, path: &Path) -> io::Result<f64>;
    /// `readdir(dir, { withFileTypes: true })` filtered to regular files —
    /// returns file names only.
    fn read_dir_files(&self, dir: &Path) -> io::Result<Vec<String>>;
}

/// Real filesystem implementation (the default, `fs.promises` in TS).
#[derive(Debug, Default, Clone, Copy)]
pub struct RealLeaseFs;

impl LeaseFs for RealLeaseFs {
    fn mkdir_recursive(&self, dir: &Path, mode: u32) -> io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true);
            builder.mode(mode);
            builder.create(dir)
        }
        #[cfg(not(unix))]
        {
            let _ = mode; // POSIX modes are a no-op on Windows (Node parity)
            std::fs::create_dir_all(dir)
        }
    }

    fn chmod(&self, path: &Path, mode: u32) -> io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        }
        #[cfg(not(unix))]
        {
            let _ = (path, mode);
            Ok(())
        }
    }

    fn open_excl_write(&self, path: &Path, contents: &str, mode: u32) -> io::Result<()> {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode);
        }
        #[cfg(not(unix))]
        {
            let _ = mode;
        }
        let mut file = options.open(path)?;
        file.write_all(contents.as_bytes())
    }

    fn write_file(&self, path: &Path, contents: &str, mode: u32) -> io::Result<()> {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode);
        }
        #[cfg(not(unix))]
        {
            let _ = mode;
        }
        let mut file = options.open(path)?;
        file.write_all(contents.as_bytes())
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        std::fs::rename(from, to)
    }

    fn unlink(&self, path: &Path) -> io::Result<()> {
        std::fs::remove_file(path)
    }

    fn read_to_string(&self, path: &Path) -> io::Result<String> {
        std::fs::read_to_string(path)
    }

    fn mtime_ms(&self, path: &Path) -> io::Result<f64> {
        let metadata = std::fs::metadata(path)?;
        let modified = metadata.modified()?;
        Ok(match modified.duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_secs_f64() * 1000.0,
            // Pre-epoch mtimes (clock weirdness): negative ms like Node.
            Err(error) => -(error.duration().as_secs_f64() * 1000.0),
        })
    }

    fn read_dir_files(&self, dir: &Path) -> io::Result<Vec<String>> {
        let mut names = Vec::new();
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let is_file = entry.file_type().map(|ft| ft.is_file()).unwrap_or(false);
            if !is_file {
                continue;
            }
            if let Some(name) = entry.file_name().to_str() {
                names.push(name.to_string());
            }
        }
        Ok(names)
    }
}

/// `RefreshLeaseCoordinatorOptions`.
#[derive(Default)]
pub struct RefreshLeaseCoordinatorOptions {
    pub enabled: Option<bool>,
    pub lease_dir: Option<PathBuf>,
    pub lease_ttl_ms: Option<i64>,
    pub wait_timeout_ms: Option<i64>,
    pub poll_interval_ms: Option<i64>,
    pub result_ttl_ms: Option<i64>,
    pub fs_ops: Option<Arc<dyn LeaseFs>>,
}

/// Lease handle role.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseRole {
    Owner,
    Follower,
    Bypass,
}

enum HandleInner {
    /// Bypass and follower handles: `release()` is a no-op.
    Noop,
    Owner {
        token_hash: String,
        lock_path: PathBuf,
        result_path: PathBuf,
        nonce: String,
        fs: Arc<dyn LeaseFs>,
        released: AtomicBool,
    },
}

/// `RefreshLeaseHandle` — `{ role, result?, release(result?) }`.
pub struct RefreshLeaseHandle {
    pub role: LeaseRole,
    pub result: Option<TokenResult>,
    inner: HandleInner,
}

impl RefreshLeaseHandle {
    pub(crate) fn bypass() -> Self {
        Self {
            role: LeaseRole::Bypass,
            result: None,
            inner: HandleInner::Noop,
        }
    }

    pub(crate) fn follower(result: TokenResult) -> Self {
        Self {
            role: LeaseRole::Follower,
            result: Some(result),
            inner: HandleInner::Noop,
        }
    }

    pub(crate) fn owner(
        token_hash: String,
        lock_path: PathBuf,
        result_path: PathBuf,
        nonce: String,
        fs: Arc<dyn LeaseFs>,
    ) -> Self {
        Self {
            role: LeaseRole::Owner,
            result: None,
            inner: HandleInner::Owner {
                token_hash,
                lock_path,
                result_path,
                nonce,
                fs,
                released: AtomicBool::new(false),
            },
        }
    }

    /// Owner `release(result?)`: idempotent. Only a SUCCESSFUL refresh result
    /// is cached for followers — a failed result carries no token material and
    /// caching it would serve the failure verbatim to every follower for the
    /// whole result TTL, blocking a real retry. The lock is unlinked only when
    /// still owned (nonce match, H2); otherwise it is left for the current
    /// owner with a warning. Follower/bypass handles: no-op.
    ///
    /// The `io::Result` mirrors the TS promise: writing the result file can
    /// fail (callers warn and continue); the unlink path never errors.
    pub async fn release(&self, result: Option<&TokenResult>) -> io::Result<()> {
        let HandleInner::Owner {
            token_hash,
            lock_path,
            result_path,
            nonce,
            fs,
            released,
        } = &self.inner
        else {
            return Ok(());
        };
        if released.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let write_outcome = match result {
            Some(result @ TokenResult::Success(_)) => {
                write_result(fs, result_path, token_hash, result).await
            }
            _ => Ok(()),
        };
        // finally: unlink the lock only if it is still OURS (stress audit H2).
        if owns_lock(fs, lock_path, token_hash, nonce) {
            safe_unlink(fs, lock_path, None, None).await;
        } else {
            log().warn(
                "Refresh lease no longer owned at release; leaving lock for current owner",
                Some(&json!({ "lockPath": lock_path.to_string_lossy() })),
            );
        }
        write_outcome
    }
}

/// `parseEnvInt` — JS `Number.parseInt(value, 10)` semantics: leading
/// whitespace skipped, optional sign, longest digit prefix; no digits ⇒ None.
fn parse_env_int(value: Option<&str>) -> Option<i64> {
    let value = value?;
    let trimmed = value.trim_start();
    let (sign, digits_part) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1i64, rest),
        None => (1i64, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let digits: String = digits_part.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let magnitude: i64 = digits.parse().unwrap_or(i64::MAX);
    Some(sign * magnitude)
}

fn hash_refresh_token(refresh_token: &str) -> String {
    let digest = Sha256::digest(refresh_token.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn parse_lease_payload(raw: &Value) -> Option<LeaseFilePayload> {
    if !is_record(raw) {
        return None;
    }
    let token_hash = raw
        .get("tokenHash")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let pid = raw.get("pid").and_then(Value::as_f64);
    let acquired_at = raw.get("acquiredAt").and_then(Value::as_f64);
    let expires_at = raw.get("expiresAt").and_then(Value::as_f64);
    // nonce is optional for backward-compat with locks written before H2.
    let nonce = raw
        .get("nonce")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let (Some(pid), Some(acquired_at), Some(expires_at)) = (pid, acquired_at, expires_at) else {
        return None;
    };
    if token_hash.is_empty()
        || !pid.is_finite()
        || !acquired_at.is_finite()
        || !expires_at.is_finite()
    {
        return None;
    }
    Some(LeaseFilePayload {
        token_hash,
        pid: pid.floor() as i64,
        acquired_at: acquired_at.floor() as i64,
        expires_at: expires_at.floor() as i64,
        nonce,
    })
}

/// Parsed `ResultFilePayload` — `result` validated with the shared
/// `TokenResult` schema; invalid ⇒ None (file ignored).
fn parse_result_payload(raw: &Value) -> Option<(String, i64, TokenResult)> {
    if !is_record(raw) {
        return None;
    }
    let token_hash = raw
        .get("tokenHash")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let created_at = raw.get("createdAt").and_then(Value::as_f64);
    let result = raw.get("result").and_then(safe_parse_token_result);
    let (Some(created_at), Some(result)) = (created_at, result) else {
        return None;
    };
    if token_hash.is_empty() || !created_at.is_finite() {
        return None;
    }
    Some((token_hash, created_at.floor() as i64, result))
}

/// `readJson` — read + parse, any error ⇒ None.
fn read_json(fs: &Arc<dyn LeaseFs>, path: &Path) -> Option<Value> {
    let content = fs.read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&content).ok()
}

/// `safeUnlink` — up to 4 attempts, base delay 15 ms doubling
/// (`15 * 2^attempt`), retrying only {EBUSY, EPERM, EMFILE, ENFILE};
/// ENOENT counts as success. Never errors.
async fn safe_unlink(
    fs: &Arc<dyn LeaseFs>,
    path: &Path,
    attempts: Option<i64>,
    base_delay_ms: Option<i64>,
) -> bool {
    let attempts = attempts.unwrap_or(4).max(1);
    let base_delay_ms = base_delay_ms.unwrap_or(15).max(5);
    for attempt in 0..attempts {
        match fs.unlink(path) {
            Ok(()) => return true,
            Err(error) => {
                let code = code_of(&error);
                if code == Some("ENOENT") {
                    return true;
                }
                let can_retry = matches!(code, Some(code) if RETRYABLE_IO_ERRORS.contains(&code));
                if can_retry && attempt + 1 < attempts {
                    sleep((base_delay_ms as u64).saturating_mul(1u64 << attempt.min(62))).await;
                    continue;
                }
                log().debug(
                    "Failed to remove lease artifact",
                    Some(&json!({
                        "path": path.to_string_lossy(),
                        "error": error.to_string(),
                        "code": code,
                    })),
                );
                return false;
            }
        }
    }
    false
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LockState {
    Stale,
    Active,
    Unknown,
}

fn is_retryable_fs_code(code: Option<&str>) -> bool {
    matches!(code, Some(code) if RETRYABLE_IO_ERRORS.contains(&code))
}

/// `ownsLock` — unreadable/absent lock ⇒ true (nothing of ours to protect);
/// tokenHash mismatch ⇒ false; empty on-disk nonce (pre-H2) ⇒ true; else
/// nonce equality.
fn owns_lock(fs: &Arc<dyn LeaseFs>, lock_path: &Path, token_hash: &str, nonce: &str) -> bool {
    let Some(raw) = read_json(fs, lock_path) else {
        return true;
    };
    let Some(parsed) = parse_lease_payload(&raw) else {
        return true;
    };
    if parsed.token_hash != token_hash {
        return false;
    }
    if parsed.nonce.is_empty() {
        return true;
    }
    parsed.nonce == nonce
}

/// `writeResult` — atomic temp+rename, temp mode 0600 (the payload embeds the
/// refreshed access + refresh tokens); temp unlinked in `finally` either way.
async fn write_result(
    fs: &Arc<dyn LeaseFs>,
    result_path: &Path,
    token_hash: &str,
    result: &TokenResult,
) -> io::Result<()> {
    let payload = json!({
        "tokenHash": token_hash,
        "createdAt": now_ms(),
        "result": result,
    });
    let temp_path = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        result_path.to_string_lossy(),
        std::process::id(),
        now_ms(),
    ));
    let outcome = async {
        fs.write_file(&temp_path, &format!("{}\n", stringify_compact(&payload)), 0o600)?;
        fs.rename(&temp_path, result_path)
    }
    .await;
    safe_unlink(fs, &temp_path, None, None).await;
    outcome
}

/// `RefreshLeaseCoordinator`.
pub struct RefreshLeaseCoordinator {
    enabled: bool,
    lease_dir: PathBuf,
    lease_ttl_ms: i64,
    wait_timeout_ms: i64,
    poll_interval_ms: i64,
    result_ttl_ms: i64,
    fs: Arc<dyn LeaseFs>,
}

impl RefreshLeaseCoordinator {
    pub fn new(options: RefreshLeaseCoordinatorOptions) -> Self {
        Self {
            enabled: options.enabled.unwrap_or(true),
            lease_dir: options
                .lease_dir
                .unwrap_or_else(|| get_codex_multi_auth_dir().join("refresh-leases")),
            lease_ttl_ms: options.lease_ttl_ms.unwrap_or(DEFAULT_LEASE_TTL_MS).max(1_000),
            wait_timeout_ms: options.wait_timeout_ms.unwrap_or(DEFAULT_WAIT_TIMEOUT_MS).max(0),
            poll_interval_ms: options
                .poll_interval_ms
                .unwrap_or(DEFAULT_POLL_INTERVAL_MS)
                .max(50),
            result_ttl_ms: options.result_ttl_ms.unwrap_or(DEFAULT_RESULT_TTL_MS).max(1_000),
            fs: options.fs_ops.unwrap_or_else(|| Arc::new(RealLeaseFs)),
        }
    }

    /// Resolved maximum time `acquire()` may block waiting for a lease.
    ///
    /// Exposed so the refresh queue can size its acquire-stage eviction
    /// threshold against the budget this coordinator ACTUALLY uses (it is
    /// configurable via constructor option / `CODEX_AUTH_REFRESH_LEASE_WAIT_MS`).
    pub fn configured_wait_timeout_ms(&self) -> i64 {
        self.wait_timeout_ms
    }

    /// `fromEnvironment()` — `enabled = parseBooleanEnv(CODEX_AUTH_REFRESH_LEASE)
    /// ?? (testMode ? false : true)` where testMode = `VITEST === "true" ||
    /// NODE_ENV === "test"`. Empty/whitespace `CODEX_AUTH_REFRESH_LEASE_DIR` is
    /// treated as unset; numeric tunables via parseInt semantics.
    pub fn from_environment() -> Self {
        let env = |key: &str| std::env::var(key).ok();
        let test_mode = env("VITEST").as_deref() == Some("true")
            || env("NODE_ENV").as_deref() == Some("test");
        let enabled = parse_boolean_env(env("CODEX_AUTH_REFRESH_LEASE").as_deref())
            .unwrap_or(!test_mode);
        let lease_dir = env("CODEX_AUTH_REFRESH_LEASE_DIR")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        Self::new(RefreshLeaseCoordinatorOptions {
            enabled: Some(enabled),
            lease_dir,
            lease_ttl_ms: parse_env_int(env("CODEX_AUTH_REFRESH_LEASE_TTL_MS").as_deref()),
            wait_timeout_ms: parse_env_int(env("CODEX_AUTH_REFRESH_LEASE_WAIT_MS").as_deref()),
            poll_interval_ms: parse_env_int(env("CODEX_AUTH_REFRESH_LEASE_POLL_MS").as_deref()),
            result_ttl_ms: parse_env_int(env("CODEX_AUTH_REFRESH_LEASE_RESULT_TTL_MS").as_deref()),
            fs_ops: None,
        })
    }

    /// `acquire(refreshToken)`.
    ///
    /// The only error path is the initial lease-dir `mkdir` (uncaught in TS
    /// too — the refresh queue catches it and falls back to a local refresh).
    /// Everything else resolves to a handle: owner, follower (cached result),
    /// or bypass (disabled / empty-token / wait-timeout / acquire-error —
    /// bypass = proceed with the refresh WITHOUT cross-process protection,
    /// never fail the refresh).
    pub async fn acquire(&self, refresh_token: &str) -> io::Result<RefreshLeaseHandle> {
        if !self.enabled {
            return Ok(self.create_bypass_handle("disabled"));
        }
        if refresh_token.trim().is_empty() {
            return Ok(self.create_bypass_handle("empty-token"));
        }

        let token_hash = hash_refresh_token(refresh_token);
        let lock_path = self.lease_dir.join(format!("{token_hash}.lock"));
        let result_path = self.lease_dir.join(format!("{token_hash}.result.json"));
        // Lease artifacts hold full OAuth token material; restrict the
        // directory to the owner (0600 files under a 0700 dir).
        self.fs.mkdir_recursive(&self.lease_dir, 0o700)?;
        // mkdir(recursive) only applies mode to dirs it actually creates;
        // tighten explicitly on POSIX so upgrades also constrain a
        // pre-existing dir. No-op on Windows, best-effort everywhere.
        #[cfg(unix)]
        if self.fs.has_chmod() {
            let _ = self.fs.chmod(&self.lease_dir, 0o700);
        }
        // Fire-and-forget prune (TS `void this.pruneExpiredArtifacts()`).
        {
            let fs = Arc::clone(&self.fs);
            let lease_dir = self.lease_dir.clone();
            let lease_ttl_ms = self.lease_ttl_ms;
            let result_ttl_ms = self.result_ttl_ms;
            tokio::spawn(async move {
                prune_expired_artifacts_in(&fs, &lease_dir, lease_ttl_ms, result_ttl_ms).await;
            });
        }

        let deadline = now_ms() + self.wait_timeout_ms;
        loop {
            if let Some(cached) = self.read_fresh_result(&result_path, &token_hash).await {
                return Ok(RefreshLeaseHandle::follower(cached));
            }

            let nonce = uuid::Uuid::new_v4().to_string();
            let now = now_ms();
            let payload = json!({
                "tokenHash": token_hash,
                "pid": std::process::id(),
                "acquiredAt": now,
                "expiresAt": now + self.lease_ttl_ms,
                "nonce": nonce,
            });
            match self.fs.open_excl_write(
                &lock_path,
                &format!("{}\n", stringify_compact(&payload)),
                0o600,
            ) {
                Ok(()) => {
                    return Ok(RefreshLeaseHandle::owner(
                        token_hash,
                        lock_path,
                        result_path,
                        nonce,
                        Arc::clone(&self.fs),
                    ));
                }
                Err(error) => {
                    let code = code_of(&error);
                    if code != Some("EEXIST") {
                        log().warn(
                            "Refresh lease acquisition failed; proceeding without lease",
                            Some(&json!({ "error": error.to_string() })),
                        );
                        return Ok(self.create_bypass_handle("acquire-error"));
                    }

                    let (state, _reason) = self.assess_lock_staleness(&lock_path, &token_hash);
                    if state == LockState::Stale {
                        let removed = safe_unlink(&self.fs, &lock_path, None, None).await;
                        if removed {
                            continue;
                        }
                        if now_ms() >= deadline {
                            log().warn(
                                "Refresh lease wait timeout while stale lock could not be removed",
                                Some(&json!({ "waitTimeoutMs": self.wait_timeout_ms })),
                            );
                            return Ok(self.create_bypass_handle("wait-timeout"));
                        }
                        sleep(self.poll_interval_ms.max(0) as u64).await;
                        continue;
                    }

                    // active / unknown
                    if now_ms() >= deadline {
                        log().warn(
                            "Refresh lease wait timeout; proceeding without lease",
                            Some(&json!({ "waitTimeoutMs": self.wait_timeout_ms })),
                        );
                        return Ok(self.create_bypass_handle("wait-timeout"));
                    }
                    sleep(self.poll_interval_ms.max(0) as u64).await;
                }
            }
        }
    }

    fn create_bypass_handle(&self, reason: &str) -> RefreshLeaseHandle {
        log().debug("Bypassing refresh lease", Some(&json!({ "reason": reason })));
        RefreshLeaseHandle::bypass()
    }

    /// `readFreshResult` — parsed + tokenHash match + `now - createdAt <=
    /// resultTtlMs` ⇒ Some(result); expired result is unlinked and treated as
    /// absent.
    async fn read_fresh_result(&self, result_path: &Path, token_hash: &str) -> Option<TokenResult> {
        // TS uses (uninjected) existsSync here.
        if !result_path.exists() {
            return None;
        }
        let raw = read_json(&self.fs, result_path)?;
        let (parsed_hash, created_at, result) = parse_result_payload(&raw)?;
        if parsed_hash != token_hash {
            return None;
        }
        let age_ms = now_ms() - created_at;
        if age_ms > self.result_ttl_ms {
            safe_unlink(&self.fs, result_path, None, None).await;
            return None;
        }
        Some(result)
    }

    /// `assessLockStaleness` — see spec 04 §5 for the full decision table.
    fn assess_lock_staleness(&self, lock_path: &Path, token_hash: &str) -> (LockState, String) {
        let raw = read_json(&self.fs, lock_path);
        let Some(raw) = raw else {
            // TS uses (uninjected) existsSync here.
            if !lock_path.exists() {
                return (LockState::Stale, "missing".to_string());
            }
            return (LockState::Unknown, "unreadable".to_string());
        };

        let Some(parsed) = parse_lease_payload(&raw) else {
            return (LockState::Unknown, "invalid-payload".to_string());
        };
        if parsed.token_hash != token_hash {
            return (LockState::Unknown, "token-mismatch".to_string());
        }
        if parsed.expires_at <= now_ms() {
            return (LockState::Stale, "expired".to_string());
        }

        match self.fs.mtime_ms(lock_path) {
            Ok(mtime_ms) => {
                if now_ms() as f64 - mtime_ms > self.lease_ttl_ms as f64 {
                    (LockState::Stale, "mtime-expired".to_string())
                } else {
                    (LockState::Active, "fresh".to_string())
                }
            }
            Err(error) => {
                let code = code_of(&error);
                if code == Some("ENOENT") {
                    return (LockState::Stale, "missing".to_string());
                }
                if is_retryable_fs_code(code) || code == Some("EACCES") {
                    return (
                        LockState::Unknown,
                        format!("stat-{}", code.unwrap_or("").to_lowercase()),
                    );
                }
                (LockState::Unknown, "stat-error".to_string())
            }
        }
    }

    /// `pruneExpiredArtifacts` — delete `.lock`/`.result.json` files whose
    /// mtime is older than `max(leaseTtlMs, resultTtlMs) * 2`; every error is
    /// swallowed (best effort). Public for test parity (the TS suite invokes
    /// it directly).
    pub async fn prune_expired_artifacts(&self) {
        prune_expired_artifacts_in(&self.fs, &self.lease_dir, self.lease_ttl_ms, self.result_ttl_ms)
            .await;
    }
}

async fn prune_expired_artifacts_in(
    fs: &Arc<dyn LeaseFs>,
    lease_dir: &Path,
    lease_ttl_ms: i64,
    result_ttl_ms: i64,
) {
    let Ok(entries) = fs.read_dir_files(lease_dir) else {
        return; // Best effort.
    };
    let now = now_ms();
    let max_age_ms = lease_ttl_ms.max(result_ttl_ms) * 2;
    for name in entries {
        if !name.ends_with(".lock") && !name.ends_with(".result.json") {
            continue;
        }
        let full_path = lease_dir.join(&name);
        match fs.mtime_ms(&full_path) {
            Ok(mtime_ms) => {
                if now as f64 - mtime_ms > max_age_ms as f64 {
                    safe_unlink(fs, &full_path, None, None).await;
                }
            }
            Err(_) => {
                // Best effort.
            }
        }
    }
}

// ============================================================================
// Tests (ported from test/refresh-lease.test.ts)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::token::{TokenSuccess, TokenResult};
    use serial_test::serial;
    use std::sync::atomic::AtomicU32;

    fn sample_success_result() -> TokenResult {
        TokenResult::Success(TokenSuccess {
            access: "access-token".to_string(),
            refresh: "refresh-token-next".to_string(),
            expires: now_ms() + 60_000,
            id_token: None,
            multi_account: None,
        })
    }

    fn temp_lease_dir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("codex-refresh-lease-")
            .tempdir()
            .expect("lease tempdir")
    }

    fn coordinator(dir: &Path, opts: RefreshLeaseCoordinatorOptions) -> RefreshLeaseCoordinator {
        RefreshLeaseCoordinator::new(RefreshLeaseCoordinatorOptions {
            enabled: Some(true),
            lease_dir: Some(dir.to_path_buf()),
            ..opts
        })
    }

    #[tokio::test]
    async fn returns_owner_then_follower_with_shared_result() {
        let dir = temp_lease_dir();
        let coordinator = coordinator(
            dir.path(),
            RefreshLeaseCoordinatorOptions {
                lease_ttl_ms: Some(5_000),
                wait_timeout_ms: Some(500),
                poll_interval_ms: Some(25),
                result_ttl_ms: Some(2_000),
                ..Default::default()
            },
        );
        let sample = sample_success_result();

        let owner = coordinator.acquire("token-a").await.unwrap();
        assert_eq!(owner.role, LeaseRole::Owner);
        owner.release(Some(&sample)).await.unwrap();

        let follower = coordinator.acquire("token-a").await.unwrap();
        assert_eq!(follower.role, LeaseRole::Follower);
        assert_eq!(follower.result, Some(sample));
    }

    #[tokio::test]
    async fn does_not_cache_a_failed_refresh_result() {
        // Regression: a `failed` result carries no token material; caching it
        // would serve the failure to every follower for the whole result TTL.
        let dir = temp_lease_dir();
        let coordinator = coordinator(
            dir.path(),
            RefreshLeaseCoordinatorOptions {
                lease_ttl_ms: Some(5_000),
                wait_timeout_ms: Some(500),
                poll_interval_ms: Some(25),
                result_ttl_ms: Some(5_000),
                ..Default::default()
            },
        );
        let failed_result = TokenResult::Failed(cma_core::schemas::token::TokenFailure {
            reason: Some(cma_core::schemas::token::TokenFailureReason::NetworkError),
            status_code: None,
            message: Some("boom".to_string()),
        });
        let sample = sample_success_result();

        let owner = coordinator.acquire("token-fail").await.unwrap();
        assert_eq!(owner.role, LeaseRole::Owner);
        owner.release(Some(&failed_result)).await.unwrap();

        // A failure was NOT cached: the next caller acquires as owner.
        let after_failure = coordinator.acquire("token-fail").await.unwrap();
        assert_eq!(after_failure.role, LeaseRole::Owner);
        assert_eq!(after_failure.result, None);
        after_failure.release(Some(&sample)).await.unwrap();

        // Happy path intact: a success IS served to a subsequent follower.
        let follower = coordinator.acquire("token-fail").await.unwrap();
        assert_eq!(follower.role, LeaseRole::Follower);
        assert_eq!(follower.result, Some(sample));
    }

    #[tokio::test]
    async fn recovers_from_stale_lock_payload() {
        let dir = temp_lease_dir();
        let coordinator = coordinator(
            dir.path(),
            RefreshLeaseCoordinatorOptions {
                lease_ttl_ms: Some(2_000),
                wait_timeout_ms: Some(300),
                poll_interval_ms: Some(20),
                ..Default::default()
            },
        );

        // Different tokenHash than "token-stale" would be token-mismatch; the
        // TS test writes the REAL hash of a fixed value with an expired lease.
        let token_hash = hash_refresh_token("token-stale");
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(
            dir.path().join(format!("{token_hash}.lock")),
            stringify_compact(&json!({
                "tokenHash": token_hash,
                "pid": 9999,
                "acquiredAt": now_ms() - 10_000,
                "expiresAt": now_ms() - 1_000,
            })),
        )
        .unwrap();

        let handle = coordinator.acquire("token-stale").await.unwrap();
        assert_eq!(handle.role, LeaseRole::Owner);
        handle.release(Some(&sample_success_result())).await.unwrap();
    }

    #[tokio::test]
    async fn supports_bypass_mode() {
        let dir = temp_lease_dir();
        let coordinator = RefreshLeaseCoordinator::new(RefreshLeaseCoordinatorOptions {
            enabled: Some(false),
            lease_dir: Some(dir.path().to_path_buf()),
            ..Default::default()
        });
        let handle = coordinator.acquire("token-b").await.unwrap();
        assert_eq!(handle.role, LeaseRole::Bypass);
        handle.release(Some(&sample_success_result())).await.unwrap();
    }

    #[tokio::test]
    async fn does_not_delete_unreadable_lock_payloads() {
        let dir = temp_lease_dir();
        let coordinator = coordinator(
            dir.path(),
            RefreshLeaseCoordinatorOptions {
                lease_ttl_ms: Some(10_000),
                wait_timeout_ms: Some(120),
                poll_interval_ms: Some(25),
                result_ttl_ms: Some(2_000),
                ..Default::default()
            },
        );
        std::fs::create_dir_all(dir.path()).unwrap();
        let token_hash = hash_refresh_token("token-partial");
        let lock_path = dir.path().join(format!("{token_hash}.lock"));
        std::fs::write(&lock_path, "{").unwrap();

        let handle = coordinator.acquire("token-partial").await.unwrap();
        assert_eq!(handle.role, LeaseRole::Bypass);
        assert_eq!(std::fs::read_to_string(&lock_path).unwrap(), "{");
    }

    /// fsOps wrapper that fails `.lock` unlinks with EBUSY a fixed number of
    /// times before delegating to the real fs.
    struct BusyUnlinkFs {
        inner: RealLeaseFs,
        busy_count: AtomicU32,
        max_busy: u32,
        unlink_calls: AtomicU32,
    }

    impl LeaseFs for BusyUnlinkFs {
        fn mkdir_recursive(&self, dir: &Path, mode: u32) -> io::Result<()> {
            self.inner.mkdir_recursive(dir, mode)
        }
        fn chmod(&self, path: &Path, mode: u32) -> io::Result<()> {
            self.inner.chmod(path, mode)
        }
        fn open_excl_write(&self, path: &Path, contents: &str, mode: u32) -> io::Result<()> {
            self.inner.open_excl_write(path, contents, mode)
        }
        fn write_file(&self, path: &Path, contents: &str, mode: u32) -> io::Result<()> {
            self.inner.write_file(path, contents, mode)
        }
        fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
            self.inner.rename(from, to)
        }
        fn unlink(&self, path: &Path) -> io::Result<()> {
            self.unlink_calls.fetch_add(1, Ordering::SeqCst);
            if path.to_string_lossy().ends_with(".lock")
                && self.busy_count.load(Ordering::SeqCst) < self.max_busy
            {
                self.busy_count.fetch_add(1, Ordering::SeqCst);
                return Err(cma_core::fs_retry::io_error_with_code("EBUSY", "busy"));
            }
            self.inner.unlink(path)
        }
        fn read_to_string(&self, path: &Path) -> io::Result<String> {
            self.inner.read_to_string(path)
        }
        fn mtime_ms(&self, path: &Path) -> io::Result<f64> {
            self.inner.mtime_ms(path)
        }
        fn read_dir_files(&self, dir: &Path) -> io::Result<Vec<String>> {
            self.inner.read_dir_files(dir)
        }
    }

    #[tokio::test]
    async fn retries_stale_lock_cleanup_when_unlink_is_temporarily_busy() {
        let dir = temp_lease_dir();
        let token_hash = hash_refresh_token("token-retry");
        let fs = Arc::new(BusyUnlinkFs {
            inner: RealLeaseFs,
            busy_count: AtomicU32::new(0),
            max_busy: 2,
            unlink_calls: AtomicU32::new(0),
        });
        let coordinator = RefreshLeaseCoordinator::new(RefreshLeaseCoordinatorOptions {
            enabled: Some(true),
            lease_dir: Some(dir.path().to_path_buf()),
            lease_ttl_ms: Some(2_000),
            wait_timeout_ms: Some(400),
            poll_interval_ms: Some(20),
            result_ttl_ms: Some(2_000),
            fs_ops: Some(fs.clone()),
        });

        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(
            dir.path().join(format!("{token_hash}.lock")),
            stringify_compact(&json!({
                "tokenHash": token_hash,
                "pid": 1111,
                "acquiredAt": now_ms() - 10_000,
                "expiresAt": now_ms() - 5_000,
            })),
        )
        .unwrap();

        let handle = coordinator.acquire("token-retry").await.unwrap();
        assert_eq!(handle.role, LeaseRole::Owner);
        assert!(fs.unlink_calls.load(Ordering::SeqCst) > 0);
        assert_eq!(fs.busy_count.load(Ordering::SeqCst), 2);
        handle.release(Some(&sample_success_result())).await.unwrap();
    }

    #[tokio::test]
    async fn times_out_to_bypass_when_stale_lock_cannot_be_deleted() {
        let dir = temp_lease_dir();
        let token_hash = hash_refresh_token("token-timeout");
        let fs = Arc::new(BusyUnlinkFs {
            inner: RealLeaseFs,
            busy_count: AtomicU32::new(0),
            max_busy: u32::MAX, // .lock unlinks always fail EBUSY
            unlink_calls: AtomicU32::new(0),
        });
        let coordinator = RefreshLeaseCoordinator::new(RefreshLeaseCoordinatorOptions {
            enabled: Some(true),
            lease_dir: Some(dir.path().to_path_buf()),
            lease_ttl_ms: Some(2_000),
            wait_timeout_ms: Some(140),
            poll_interval_ms: Some(25),
            result_ttl_ms: Some(2_000),
            fs_ops: Some(fs.clone()),
        });

        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(
            dir.path().join(format!("{token_hash}.lock")),
            stringify_compact(&json!({
                "tokenHash": token_hash,
                "pid": 2222,
                "acquiredAt": now_ms() - 10_000,
                "expiresAt": now_ms() - 5_000,
            })),
        )
        .unwrap();

        let handle = coordinator.acquire("token-timeout").await.unwrap();
        assert_eq!(handle.role, LeaseRole::Bypass);
        assert!(fs.unlink_calls.load(Ordering::SeqCst) > 0);
        handle.release(Some(&sample_success_result())).await.unwrap();
    }

    #[tokio::test]
    async fn treats_empty_refresh_token_as_bypass() {
        let dir = temp_lease_dir();
        let coordinator = coordinator(dir.path(), RefreshLeaseCoordinatorOptions::default());
        let handle = coordinator.acquire("   ").await.unwrap();
        assert_eq!(handle.role, LeaseRole::Bypass);
        handle.release(Some(&sample_success_result())).await.unwrap();
    }

    #[tokio::test]
    #[serial(env)]
    async fn parses_environment_toggle_values_in_from_environment() {
        let dir = temp_lease_dir();
        let mut sandbox = cma_testkit::sandbox::EnvSandbox::new();

        sandbox.set_var("VITEST", "false");
        sandbox.set_var("NODE_ENV", "production");
        sandbox.set_var("CODEX_AUTH_REFRESH_LEASE", "yes");
        sandbox.set_var(
            "CODEX_AUTH_REFRESH_LEASE_DIR",
            format!("{}\n", dir.path().to_string_lossy()),
        );
        sandbox.set_var("CODEX_AUTH_REFRESH_LEASE_TTL_MS", "2500");
        sandbox.set_var("CODEX_AUTH_REFRESH_LEASE_WAIT_MS", "900");
        sandbox.set_var("CODEX_AUTH_REFRESH_LEASE_POLL_MS", "60");
        sandbox.set_var("CODEX_AUTH_REFRESH_LEASE_RESULT_TTL_MS", "2500");

        let enabled_coordinator = RefreshLeaseCoordinator::from_environment();
        assert_eq!(enabled_coordinator.configured_wait_timeout_ms(), 900);
        let enabled_handle = enabled_coordinator.acquire("token-env-enabled").await.unwrap();
        assert_eq!(enabled_handle.role, LeaseRole::Owner);
        enabled_handle
            .release(Some(&sample_success_result()))
            .await
            .unwrap();

        sandbox.set_var("VITEST", "true");
        sandbox.set_var("NODE_ENV", "test");
        sandbox.set_var("CODEX_AUTH_REFRESH_LEASE", "maybe");
        let invalid_value_coordinator = RefreshLeaseCoordinator::from_environment();
        let invalid_handle = invalid_value_coordinator
            .acquire("token-env-invalid")
            .await
            .unwrap();
        assert_eq!(invalid_handle.role, LeaseRole::Bypass);

        sandbox.set_var("CODEX_AUTH_REFRESH_LEASE", "no");
        let disabled_coordinator = RefreshLeaseCoordinator::from_environment();
        let disabled_handle = disabled_coordinator
            .acquire("token-env-disabled")
            .await
            .unwrap();
        assert_eq!(disabled_handle.role, LeaseRole::Bypass);
    }

    /// fsOps whose exclusive open always fails EACCES.
    struct OpenFailFs {
        inner: RealLeaseFs,
        open_calls: AtomicU32,
    }

    impl LeaseFs for OpenFailFs {
        fn mkdir_recursive(&self, dir: &Path, mode: u32) -> io::Result<()> {
            self.inner.mkdir_recursive(dir, mode)
        }
        fn chmod(&self, path: &Path, mode: u32) -> io::Result<()> {
            self.inner.chmod(path, mode)
        }
        fn open_excl_write(&self, _path: &Path, _contents: &str, _mode: u32) -> io::Result<()> {
            self.open_calls.fetch_add(1, Ordering::SeqCst);
            Err(cma_core::fs_retry::io_error_with_code("EACCES", "permission"))
        }
        fn write_file(&self, path: &Path, contents: &str, mode: u32) -> io::Result<()> {
            self.inner.write_file(path, contents, mode)
        }
        fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
            self.inner.rename(from, to)
        }
        fn unlink(&self, path: &Path) -> io::Result<()> {
            self.inner.unlink(path)
        }
        fn read_to_string(&self, path: &Path) -> io::Result<String> {
            self.inner.read_to_string(path)
        }
        fn mtime_ms(&self, path: &Path) -> io::Result<f64> {
            self.inner.mtime_ms(path)
        }
        fn read_dir_files(&self, dir: &Path) -> io::Result<Vec<String>> {
            self.inner.read_dir_files(dir)
        }
    }

    #[tokio::test]
    async fn bypasses_when_lock_open_fails_with_non_eexist_error() {
        let dir = temp_lease_dir();
        let fs = Arc::new(OpenFailFs {
            inner: RealLeaseFs,
            open_calls: AtomicU32::new(0),
        });
        let coordinator = RefreshLeaseCoordinator::new(RefreshLeaseCoordinatorOptions {
            enabled: Some(true),
            lease_dir: Some(dir.path().to_path_buf()),
            wait_timeout_ms: Some(80),
            poll_interval_ms: Some(20),
            fs_ops: Some(fs.clone()),
            ..Default::default()
        });

        let handle = coordinator.acquire("token-open-error").await.unwrap();
        assert_eq!(handle.role, LeaseRole::Bypass);
        assert!(fs.open_calls.load(Ordering::SeqCst) > 0);
    }

    #[tokio::test]
    async fn ignores_mismatched_result_payload_and_stale_results() {
        let dir = temp_lease_dir();
        let token_hash = hash_refresh_token("token-result-paths");
        let result_path = dir.path().join(format!("{token_hash}.result.json"));
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(
            &result_path,
            stringify_compact(&json!({
                "tokenHash": "different-hash",
                "createdAt": now_ms(),
                "result": sample_success_result(),
            })),
        )
        .unwrap();

        let c1 = coordinator(
            dir.path(),
            RefreshLeaseCoordinatorOptions {
                wait_timeout_ms: Some(120),
                poll_interval_ms: Some(20),
                result_ttl_ms: Some(2_000),
                ..Default::default()
            },
        );
        let handle = c1.acquire("token-result-paths").await.unwrap();
        assert_eq!(handle.role, LeaseRole::Owner);
        handle.release(None).await.unwrap();

        std::fs::write(
            &result_path,
            stringify_compact(&json!({
                "tokenHash": token_hash,
                "createdAt": now_ms() - 10_000,
                "result": sample_success_result(),
            })),
        )
        .unwrap();

        let c2 = coordinator(
            dir.path(),
            RefreshLeaseCoordinatorOptions {
                wait_timeout_ms: Some(120),
                poll_interval_ms: Some(20),
                result_ttl_ms: Some(500),
                ..Default::default()
            },
        );
        let handle = c2.acquire("token-result-paths").await.unwrap();
        assert_eq!(handle.role, LeaseRole::Owner);
        handle.release(None).await.unwrap();
        // The stale result was unlinked while reading.
        assert!(!result_path.exists());
    }

    /// fsOps whose stat of the lock path fails EACCES.
    struct StatEaccesFs {
        inner: RealLeaseFs,
        lock_path: PathBuf,
    }

    impl LeaseFs for StatEaccesFs {
        fn mkdir_recursive(&self, dir: &Path, mode: u32) -> io::Result<()> {
            self.inner.mkdir_recursive(dir, mode)
        }
        fn chmod(&self, path: &Path, mode: u32) -> io::Result<()> {
            self.inner.chmod(path, mode)
        }
        fn open_excl_write(&self, path: &Path, contents: &str, mode: u32) -> io::Result<()> {
            self.inner.open_excl_write(path, contents, mode)
        }
        fn write_file(&self, path: &Path, contents: &str, mode: u32) -> io::Result<()> {
            self.inner.write_file(path, contents, mode)
        }
        fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
            self.inner.rename(from, to)
        }
        fn unlink(&self, path: &Path) -> io::Result<()> {
            self.inner.unlink(path)
        }
        fn read_to_string(&self, path: &Path) -> io::Result<String> {
            self.inner.read_to_string(path)
        }
        fn mtime_ms(&self, path: &Path) -> io::Result<f64> {
            if path == self.lock_path {
                return Err(cma_core::fs_retry::io_error_with_code(
                    "EACCES",
                    "access denied",
                ));
            }
            self.inner.mtime_ms(path)
        }
        fn read_dir_files(&self, dir: &Path) -> io::Result<Vec<String>> {
            self.inner.read_dir_files(dir)
        }
    }

    #[tokio::test]
    async fn handles_lock_staleness_edge_cases_from_stat_and_payload_validation() {
        let dir = temp_lease_dir();
        let token_hash = hash_refresh_token("token-staleness-cases");
        let lock_path = dir.path().join(format!("{token_hash}.lock"));
        std::fs::create_dir_all(dir.path()).unwrap();

        // Invalid payload (pid: "bad") ⇒ unknown ⇒ never stolen ⇒ bypass.
        std::fs::write(
            &lock_path,
            stringify_compact(&json!({ "tokenHash": token_hash, "pid": "bad" })),
        )
        .unwrap();
        let c1 = coordinator(
            dir.path(),
            RefreshLeaseCoordinatorOptions {
                lease_ttl_ms: Some(2_000),
                wait_timeout_ms: Some(120),
                poll_interval_ms: Some(20),
                ..Default::default()
            },
        );
        let handle = c1.acquire("token-staleness-cases").await.unwrap();
        assert_eq!(handle.role, LeaseRole::Bypass);

        // Fresh expiresAt but ancient mtime ⇒ mtime-expired ⇒ stolen ⇒ owner.
        std::fs::write(
            &lock_path,
            stringify_compact(&json!({
                "tokenHash": token_hash,
                "pid": std::process::id(),
                "acquiredAt": now_ms(),
                "expiresAt": now_ms() + 5_000,
            })),
        )
        .unwrap();
        set_file_mtime_secs_ago(&lock_path, 10);
        let c2 = coordinator(
            dir.path(),
            RefreshLeaseCoordinatorOptions {
                lease_ttl_ms: Some(1_000),
                wait_timeout_ms: Some(160),
                poll_interval_ms: Some(20),
                ..Default::default()
            },
        );
        let handle = c2.acquire("token-staleness-cases").await.unwrap();
        assert_eq!(handle.role, LeaseRole::Owner);
        handle.release(Some(&sample_success_result())).await.unwrap();
        let _ = std::fs::remove_file(dir.path().join(format!("{token_hash}.result.json")));

        // stat EACCES ⇒ unknown ⇒ bypass after the wait budget.
        std::fs::write(
            &lock_path,
            stringify_compact(&json!({
                "tokenHash": token_hash,
                "pid": std::process::id(),
                "acquiredAt": now_ms(),
                "expiresAt": now_ms() + 5_000,
            })),
        )
        .unwrap();
        let fs = Arc::new(StatEaccesFs {
            inner: RealLeaseFs,
            lock_path: lock_path.clone(),
        });
        let c3 = RefreshLeaseCoordinator::new(RefreshLeaseCoordinatorOptions {
            enabled: Some(true),
            lease_dir: Some(dir.path().to_path_buf()),
            lease_ttl_ms: Some(5_000),
            wait_timeout_ms: Some(120),
            poll_interval_ms: Some(20),
            fs_ops: Some(fs),
            ..Default::default()
        });
        let handle = c3.acquire("token-staleness-cases").await.unwrap();
        assert_eq!(handle.role, LeaseRole::Bypass);
    }

    #[tokio::test]
    async fn rejects_array_json_payloads_in_result_and_lock_files() {
        // Pins the canonical isRecord contract: a top-level JSON array must
        // never be treated as a lease or result record.
        let dir = temp_lease_dir();
        let token_hash = hash_refresh_token("token-array-payload");
        let lock_path = dir.path().join(format!("{token_hash}.lock"));
        let result_path = dir.path().join(format!("{token_hash}.result.json"));
        std::fs::create_dir_all(dir.path()).unwrap();

        // An array result file must not turn the caller into a follower.
        std::fs::write(&result_path, "[]\n").unwrap();
        let c = coordinator(
            dir.path(),
            RefreshLeaseCoordinatorOptions {
                lease_ttl_ms: Some(2_000),
                wait_timeout_ms: Some(120),
                poll_interval_ms: Some(20),
                result_ttl_ms: Some(2_000),
                ..Default::default()
            },
        );
        let owner = c.acquire("token-array-payload").await.unwrap();
        assert_eq!(owner.role, LeaseRole::Owner);
        owner.release(None).await.unwrap();

        // An array lock file is an invalid payload: never owned, never stale,
        // so the acquire times out and bypasses instead of stealing the lock.
        std::fs::write(&lock_path, "[]\n").unwrap();
        let blocked = c.acquire("token-array-payload").await.unwrap();
        assert_eq!(blocked.role, LeaseRole::Bypass);
        blocked.release(None).await.unwrap();
        assert_eq!(std::fs::read_to_string(&lock_path).unwrap(), "[]\n");
    }

    fn set_file_mtime_secs_ago(path: &Path, secs_ago: u64) {
        // No utimes in std: rewrite the mtime via filetime-free fallback —
        // sleep-based aging is too slow, so use the OS-level API through
        // `std::fs::File::set_times` (stable since 1.75).
        let file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        let target = std::time::SystemTime::now() - std::time::Duration::from_secs(secs_ago);
        let times = std::fs::FileTimes::new()
            .set_accessed(target)
            .set_modified(target);
        file.set_times(times).unwrap();
    }

    #[tokio::test]
    async fn prunes_stale_artifacts_while_keeping_non_file_entries() {
        let dir = temp_lease_dir();
        std::fs::create_dir_all(dir.path()).unwrap();
        let stale_lock = dir.path().join("stale.lock");
        let stale_result = dir.path().join("stale.result.json");
        let live_other = dir.path().join("ignore.txt");
        let nested_dir = dir.path().join("nested-dir");
        std::fs::write(&stale_lock, "{}").unwrap();
        std::fs::write(&stale_result, "{}").unwrap();
        std::fs::write(&live_other, "keep").unwrap();
        std::fs::create_dir_all(&nested_dir).unwrap();
        set_file_mtime_secs_ago(&stale_lock, 60);
        set_file_mtime_secs_ago(&stale_result, 60);

        let coordinator = coordinator(
            dir.path(),
            RefreshLeaseCoordinatorOptions {
                lease_ttl_ms: Some(2_000),
                result_ttl_ms: Some(2_000),
                ..Default::default()
            },
        );
        coordinator.prune_expired_artifacts().await;

        assert!(!stale_lock.exists());
        assert!(!stale_result.exists());
        assert_eq!(std::fs::read_to_string(&live_other).unwrap(), "keep");
        assert!(nested_dir.is_dir());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn creates_lease_dir_0700_and_token_result_lock_files_0600() {
        use std::os::unix::fs::MetadataExt;
        let dir = temp_lease_dir();
        let own_lease_dir = dir.path().join("perm-check");
        let coordinator = coordinator(
            &own_lease_dir,
            RefreshLeaseCoordinatorOptions {
                lease_ttl_ms: Some(5_000),
                wait_timeout_ms: Some(500),
                poll_interval_ms: Some(25),
                result_ttl_ms: Some(5_000),
                ..Default::default()
            },
        );

        let owner = coordinator.acquire("token-perms").await.unwrap();
        assert_eq!(owner.role, LeaseRole::Owner);

        let token_hash = hash_refresh_token("token-perms");
        let lock_path = own_lease_dir.join(format!("{token_hash}.lock"));
        let result_path = own_lease_dir.join(format!("{token_hash}.result.json"));

        assert_eq!(std::fs::metadata(&own_lease_dir).unwrap().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(&lock_path).unwrap().mode() & 0o777, 0o600);

        owner.release(Some(&sample_success_result())).await.unwrap();

        assert_eq!(std::fs::metadata(&result_path).unwrap().mode() & 0o777, 0o600);
    }

    #[tokio::test]
    async fn h2_slow_owner_release_does_not_delete_a_stolen_lock() {
        // Owner A acquires with a very short TTL; its lease expires; owner B
        // steals the lock. When A finally releases, it must NOT unlink B's
        // lock (stress audit H2).
        let dir = temp_lease_dir();
        let coordinator = coordinator(
            dir.path(),
            RefreshLeaseCoordinatorOptions {
                lease_ttl_ms: Some(1_000), // clamp floor; TS used 30 but 1_000 is the min
                wait_timeout_ms: Some(4_000),
                poll_interval_ms: Some(50),
                result_ttl_ms: Some(2_000),
                ..Default::default()
            },
        );

        let owner_a = coordinator.acquire("token-steal").await.unwrap();
        assert_eq!(owner_a.role, LeaseRole::Owner);

        // Let A's lease go stale (both expiresAt and mtime), then B steals it.
        let token_hash = hash_refresh_token("token-steal");
        let lock_path = dir.path().join(format!("{token_hash}.lock"));
        // Age the lock artificially instead of sleeping past the 1 s TTL:
        // rewrite expiresAt into the past (keeping A's nonce) + age the mtime.
        let payload: Value =
            serde_json::from_str(&std::fs::read_to_string(&lock_path).unwrap()).unwrap();
        let mut aged = payload.clone();
        aged["acquiredAt"] = json!(now_ms() - 10_000);
        aged["expiresAt"] = json!(now_ms() - 5_000);
        std::fs::write(&lock_path, format!("{}\n", stringify_compact(&aged))).unwrap();
        set_file_mtime_secs_ago(&lock_path, 10);

        let owner_b = coordinator.acquire("token-steal").await.unwrap();
        assert_eq!(owner_b.role, LeaseRole::Owner);

        let b_payload: Value =
            serde_json::from_str(&std::fs::read_to_string(&lock_path).unwrap()).unwrap();

        // A releases late — must leave B's lock intact.
        owner_a.release(Some(&sample_success_result())).await.unwrap();

        let after_payload: Value =
            serde_json::from_str(&std::fs::read_to_string(&lock_path).unwrap()).unwrap();
        assert_eq!(after_payload["nonce"], b_payload["nonce"]);
        assert_ne!(after_payload["nonce"], payload["nonce"]);
    }

    #[test]
    fn parse_env_int_matches_js_parse_int() {
        assert_eq!(parse_env_int(None), None);
        assert_eq!(parse_env_int(Some("2500")), Some(2500));
        assert_eq!(parse_env_int(Some(" 900 ")), Some(900));
        assert_eq!(parse_env_int(Some("60x")), Some(60));
        assert_eq!(parse_env_int(Some("-15")), Some(-15));
        assert_eq!(parse_env_int(Some("+15")), Some(15));
        assert_eq!(parse_env_int(Some("abc")), None);
        assert_eq!(parse_env_int(Some("")), None);
    }
}
