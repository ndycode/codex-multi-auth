//! Port of `lib/local-client-tokens.ts` — persisted hashed bearer tokens for
//! the local bridge (`local-client-tokens.json`).
//!
//! Behavior source: specs/07-auth.md §9 (+ gotchas 11–13).
//!
//! **Only SHA-256 hashes are stored; the plaintext (`cma_local_*`) is shown
//! once at creation.** On-disk format is byte-compatible:
//! `JSON.stringify(store, null, 2) + "\n"` with record field order
//! `id, label, prefix, tokenHash, createdAt, lastUsedAt, revokedAt`
//! (`null` literals, never absent).
//!
//! Write discipline (gotcha 11): a module-level write queue serializes the
//! ENTIRE read-modify-write of every mutation; temp file (0600) + fsync +
//! rename with 5×(10·2^n ms) retries on {EBUSY, EPERM, EAGAIN, ENOTEMPTY,
//! EACCES}; dir mkdir 0700 + POSIX re-chmod 0700 (best-effort).
//!
//! `lastUsedAt` debounce (gotcha 12): advance in-memory on every verify;
//! flush to disk only when never persisted or ≥ 60 s past the persisted value.

use std::io;
use std::path::PathBuf;
use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::TryRngCore;
use rand::rngs::OsRng;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex as TokioMutex;

use cma_core::fs_retry::{Backoff, FILE_RETRY_CODES, RetryOptions, with_retry};
use cma_core::json_io::stringify_pretty2;
use cma_core::logger::log_warn;
use cma_core::runtime_paths::get_codex_multi_auth_dir;
use cma_core::temp_path::temp_path_for;
use cma_core::utils::{is_record, now_ms};

/// One stored token record. Field order = serialization order (byte compat).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LocalClientTokenRecord {
    pub id: String,
    pub label: String,
    pub prefix: String,
    #[serde(rename = "tokenHash")]
    pub token_hash: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    /// Serialized as a `null` literal when absent (never omitted).
    #[serde(rename = "lastUsedAt")]
    pub last_used_at: Option<i64>,
    /// Serialized as a `null` literal when absent (never omitted).
    #[serde(rename = "revokedAt")]
    pub revoked_at: Option<i64>,
}

/// `{ "version": 1, "tokens": [...] }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LocalClientTokenStore {
    pub version: u32,
    pub tokens: Vec<LocalClientTokenRecord>,
}

/// `{ plainToken, record }` — the plaintext exists ONLY here, at creation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreatedLocalClientToken {
    pub plain_token: String,
    pub record: LocalClientTokenRecord,
}

const TOKEN_FILE_NAME: &str = "local-client-tokens.json";
const TOKEN_PREFIX: &str = "cma_local";
/// Debounce window for persisting a record's lastUsedAt: bearer verification
/// is on the auth hot path of every authenticated bridge request, so we
/// coalesce updates instead of temp-write+renaming per request. lastUsedAt is
/// informational only (`bridge token list`).
const LAST_USED_PERSIST_THRESHOLD_MS: i64 = 60_000;

// The retryable code set {EBUSY, EPERM, EAGAIN, ENOTEMPTY, EACCES} is exactly
// cma_core::fs_retry::FILE_RETRY_CODES; passed explicitly below so a change to
// the shared default can never silently alter this call site's contract.
const RETRYABLE_FS_CODES: &[&str] = FILE_RETRY_CODES;

/// Module-level write queue: each queued task runs only after the previous one
/// has fully settled (tokio Mutex = fair FIFO; errors cannot poison it).
/// Routing the ENTIRE read-modify-write through here prevents lost updates
/// between concurrent public ops.
static WRITE_QUEUE: LazyLock<TokioMutex<()>> = LazyLock::new(|| TokioMutex::new(()));

/// 5 attempts, `10 * 2^n` ms backoff (10/20/40/80) on the retryable code set.
fn fs_retry_options() -> RetryOptions<io::Error> {
    // `Backoff` gets the 1-based failed-attempt index: 10 * 2^(n-1).
    RetryOptions::new(
        5,
        Backoff::from_fn(|failed_attempt| {
            10u64.saturating_mul(1u64 << (failed_attempt.saturating_sub(1)).min(62))
        }),
    )
    .with_codes(RETRYABLE_FS_CODES)
}

/// `normalizeLabel` — trim, non-empty, first 80 chars, default `"local-client"`.
fn normalize_label(value: Option<&str>) -> String {
    let trimmed = value.map(str::trim).unwrap_or("");
    if trimmed.is_empty() {
        "local-client".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

/// `hashToken` — `"sha256:" + hex(sha256(utf8 token))`.
fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    let mut out = String::with_capacity(7 + 64);
    out.push_str("sha256:");
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// `createPlainToken` — `cma_local_<base64url(32 CSPRNG bytes)>` (53 chars).
fn create_plain_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng
        .try_fill_bytes(&mut bytes)
        .expect("CSPRNG unavailable: cannot generate local client token");
    format!("{TOKEN_PREFIX}_{}", URL_SAFE_NO_PAD.encode(bytes))
}

/// `tokenPrefix` — first 18 chars (`"cma_local_" + 8`).
fn token_prefix(token: &str) -> String {
    token.chars().take(18).collect()
}

fn empty_store() -> LocalClientTokenStore {
    LocalClientTokenStore {
        version: 1,
        tokens: Vec::new(),
    }
}

/// JS "finite number" check on a JSON value.
fn finite_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|number| number.is_finite())
}

/// `normalizeRecord` — drop records missing a non-blank `id` or a
/// `sha256:`-prefixed `tokenHash`; normalize the rest.
fn normalize_record(value: &Value) -> Option<LocalClientTokenRecord> {
    if !is_record(value) {
        return None;
    }
    let id = value.get("id").and_then(Value::as_str)?;
    if id.trim().is_empty() {
        return None;
    }
    let token_hash = value.get("tokenHash").and_then(Value::as_str)?;
    if !token_hash.starts_with("sha256:") {
        return None;
    }
    Some(LocalClientTokenRecord {
        id: id.trim().to_string(),
        label: normalize_label(value.get("label").and_then(Value::as_str)),
        prefix: value
            .get("prefix")
            .and_then(Value::as_str)
            .map(|prefix| prefix.chars().take(32).collect())
            .unwrap_or_default(),
        token_hash: token_hash.to_string(),
        created_at: finite_number(value.get("createdAt")).map_or(0, |number| number as i64),
        last_used_at: finite_number(value.get("lastUsedAt")).map(|number| number as i64),
        revoked_at: finite_number(value.get("revokedAt")).map(|number| number as i64),
    })
}

/// `normalizeStore` — non-record, `version !== 1`, or non-array `tokens` ⇒
/// empty store; per-record normalization drops invalid entries.
fn normalize_store(value: &Value) -> LocalClientTokenStore {
    // JS `value.version !== 1` compares as a double: a JSON `1.0` passes.
    if !is_record(value)
        || value.get("version").and_then(Value::as_f64) != Some(1.0)
        || !value.get("tokens").is_some_and(Value::is_array)
    {
        return empty_store();
    }
    let tokens = value
        .get("tokens")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(normalize_record).collect())
        .unwrap_or_default();
    LocalClientTokenStore { version: 1, tokens }
}

/// `readFileWithRetry` — 5 attempts, retryable codes, 10·2^n backoff.
async fn read_file_with_retry(path: &std::path::Path) -> io::Result<String> {
    let path = path.to_path_buf();
    with_retry(
        || {
            let path = path.clone();
            async move { std::fs::read_to_string(&path) }
        },
        fs_retry_options(),
    )
    .await
}

/// `getLocalClientTokenPath()`.
pub fn get_local_client_token_path() -> PathBuf {
    get_codex_multi_auth_dir().join(TOKEN_FILE_NAME)
}

/// `loadLocalClientTokenStore()` — NOT queued (snapshot read). Load errors are
/// fail-open to an empty store with a warning, never a crash.
pub async fn load_local_client_token_store() -> LocalClientTokenStore {
    let path = get_local_client_token_path();
    if !path.exists() {
        return empty_store();
    }
    let loaded: Result<Value, String> = match read_file_with_retry(&path).await {
        Ok(raw) => serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    match loaded {
        Ok(value) => normalize_store(&value),
        Err(message) => {
            let basename = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string_lossy().into_owned());
            log_warn(
                &format!("Failed to load local client tokens from {basename}: {message}"),
                None,
            );
            empty_store()
        }
    }
}

/// `writeStoreToDisk` — re-normalize, 0700 dir (+ best-effort POSIX chmod for
/// pre-existing dirs), temp file 0600 + **fsync before rename** (a crash after
/// the rename must not leave a truncated store), rename with retries, temp
/// unlinked when never moved.
async fn write_store_to_disk(store: &LocalClientTokenStore) -> io::Result<()> {
    let path = get_local_client_token_path();
    let payload = normalize_store(&serde_json::to_value(store).unwrap_or(Value::Null));
    let dir = get_codex_multi_auth_dir();
    // This store holds token hashes: keep the directory owner-only on POSIX
    // (mode is a no-op on win32 / ACL-based).
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        builder.mode(0o700);
        builder.create(&dir)?;
        // mkdir's mode only applies to a freshly-created dir; re-assert 0700
        // so upgrades constrain a pre-existing multi-auth dir. Best-effort.
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(&dir)?;
    }

    let temp_path = temp_path_for(&path);
    let mut moved = false;
    let outcome: io::Result<()> = async {
        // Stage the payload at 0600 and fsync before rename (stress audit L3).
        {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp_path)?;
            file.write_all(format!("{}\n", stringify_pretty2(&payload)).as_bytes())?;
            file.sync_all()?;
        }
        with_retry(
            || {
                let temp_path = temp_path.clone();
                let path = path.clone();
                async move { std::fs::rename(&temp_path, &path) }
            },
            fs_retry_options(),
        )
        .await?;
        moved = true;
        Ok(())
    }
    .await;
    if !moved {
        // Best-effort temp cleanup.
        let _ = std::fs::remove_file(&temp_path);
    }
    outcome
}

/// `saveLocalClientTokenStore(store)` — queued write.
pub async fn save_local_client_token_store(store: &LocalClientTokenStore) -> io::Result<()> {
    let _queue = WRITE_QUEUE.lock().await;
    write_store_to_disk(store).await
}

/// `createLocalClientTokenRecord({label?, now?})` — pure; the plaintext is
/// returned exactly once.
pub fn create_local_client_token_record(
    label: Option<&str>,
    now: Option<i64>,
) -> CreatedLocalClientToken {
    let plain_token = create_plain_token();
    let record = LocalClientTokenRecord {
        id: uuid::Uuid::new_v4().to_string(),
        label: normalize_label(label),
        prefix: token_prefix(&plain_token),
        token_hash: hash_token(&plain_token),
        created_at: now.unwrap_or_else(now_ms),
        last_used_at: None,
        revoked_at: None,
    };
    CreatedLocalClientToken {
        plain_token,
        record,
    }
}

/// `addLocalClientToken({label?, now?})` — queued load→create→push→write.
pub async fn add_local_client_token(
    label: Option<&str>,
    now: Option<i64>,
) -> io::Result<CreatedLocalClientToken> {
    let _queue = WRITE_QUEUE.lock().await;
    let mut store = load_local_client_token_store().await;
    let created = create_local_client_token_record(label, now);
    store.tokens.push(created.record.clone());
    write_store_to_disk(&store).await?;
    Ok(created)
}

/// `rotateLocalClientToken({id, label?, now?})` — queued; missing or already
/// revoked ⇒ None; else revoke the old record and append a new one (label
/// defaults to the old label) in ONE write.
pub async fn rotate_local_client_token(
    id: &str,
    label: Option<&str>,
    now: Option<i64>,
) -> io::Result<Option<CreatedLocalClientToken>> {
    let _queue = WRITE_QUEUE.lock().await;
    let mut store = load_local_client_token_store().await;
    let Some(position) = store.tokens.iter().position(|record| record.id == id) else {
        return Ok(None);
    };
    if store.tokens[position].revoked_at.is_some() {
        return Ok(None);
    }
    let now = now.unwrap_or_else(now_ms);
    store.tokens[position].revoked_at = Some(now);
    let existing_label = store.tokens[position].label.clone();
    let created = create_local_client_token_record(
        Some(label.unwrap_or(existing_label.as_str())),
        Some(now),
    );
    store.tokens.push(created.record.clone());
    write_store_to_disk(&store).await?;
    Ok(Some(created))
}

/// `revokeLocalClientToken(id, now?)` — queued; false when missing/already
/// revoked; else set `revokedAt`, write, true.
pub async fn revoke_local_client_token(id: &str, now: Option<i64>) -> io::Result<bool> {
    let _queue = WRITE_QUEUE.lock().await;
    let mut store = load_local_client_token_store().await;
    let Some(existing) = store.tokens.iter_mut().find(|record| record.id == id) else {
        return Ok(false);
    };
    if existing.revoked_at.is_some() {
        return Ok(false);
    }
    existing.revoked_at = Some(now.unwrap_or_else(now_ms));
    write_store_to_disk(&store).await?;
    Ok(true)
}

/// `/^Bearer\s+(.+)$/i` + trim, hand-rolled (same accept/reject set): the
/// scheme is case-insensitive, at least one whitespace separator is required,
/// and the remainder must be a non-empty single line.
fn parse_bearer_token(authorization_header: &str) -> Option<String> {
    let header = authorization_header;
    if header.len() < 6 || !header.is_char_boundary(6) {
        return None;
    }
    let (scheme, rest) = header.split_at(6);
    if !scheme.eq_ignore_ascii_case("Bearer") {
        return None;
    }
    let after_ws = rest.trim_start();
    // `\s+` requires at least one whitespace char between scheme and token.
    if after_ws.len() == rest.len() {
        return None;
    }
    // JS `.` never matches line terminators, so any embedded newline fails
    // the anchored match.
    if after_ws.is_empty()
        || after_ws.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
    {
        return None;
    }
    let token = after_ws.trim();
    if token.is_empty() {
        return None;
    }
    Some(token.to_string())
}

/// `verifyLocalClientBearerToken(authorizationHeader, now?)` — queued lookup
/// on hash AND `revokedAt === null`. Always advances `lastUsedAt` in-memory;
/// flushes to disk only when never persisted or ≥ 60 s past the persisted
/// value (hot-path debounce). Token match never depends on `lastUsedAt`.
pub async fn verify_local_client_bearer_token(
    authorization_header: Option<&str>,
    now: Option<i64>,
) -> io::Result<Option<LocalClientTokenRecord>> {
    let Some(token) = authorization_header.and_then(parse_bearer_token) else {
        return Ok(None);
    };
    let token_hash = hash_token(&token);
    let now = now.unwrap_or_else(now_ms);

    let _queue = WRITE_QUEUE.lock().await;
    let mut store = load_local_client_token_store().await;
    let Some(record) = store
        .tokens
        .iter_mut()
        .find(|entry| entry.revoked_at.is_none() && entry.token_hash == token_hash)
    else {
        return Ok(None);
    };
    let persisted = record.last_used_at;
    record.last_used_at = Some(now);
    let fresh = record.clone();
    let should_flush = match persisted {
        None => true,
        Some(persisted) => now - persisted >= LAST_USED_PERSIST_THRESHOLD_MS,
    };
    if should_flush {
        write_store_to_disk(&store).await?;
    }
    Ok(Some(fresh))
}

/// `resetLocalClientTokenWriteQueueForTests()` — the TS seam reset a promise
/// chain; the tokio mutex queue cannot be poisoned, so this is a no-op kept
/// for API parity.
pub fn reset_local_client_token_write_queue_for_tests() {}

// ============================================================================
// Tests (ported from test/local-client-tokens.test.ts + golden byte gate)
//
// All tests redirect CODEX_MULTI_AUTH_DIR through EnvSandbox ⇒ #[serial(env)].
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::goldens::{assert_golden_str, read_golden_string};
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    #[tokio::test]
    #[serial(env)]
    async fn stores_hashes_and_verifies_bearer_tokens_without_persisting_plaintext() {
        let _sandbox = EnvSandbox::new();

        let created = add_local_client_token(Some("OpenCode"), Some(100))
            .await
            .unwrap();
        assert!(created.plain_token.starts_with("cma_local_"));
        assert!(created.record.token_hash.starts_with("sha256:"));
        assert_eq!(
            created.record.prefix,
            created.plain_token.chars().take(18).collect::<String>()
        );

        let raw = std::fs::read_to_string(get_local_client_token_path()).unwrap();
        assert!(!raw.contains(&created.plain_token));
        assert!(raw.contains(&created.record.prefix));

        let verified = verify_local_client_bearer_token(
            Some(&format!("Bearer {}", created.plain_token)),
            Some(200),
        )
        .await
        .unwrap();
        assert_eq!(verified.as_ref().map(|record| record.id.as_str()), Some(created.record.id.as_str()));
        let loaded = load_local_client_token_store().await;
        assert_eq!(loaded.tokens[0].last_used_at, Some(200));
    }

    #[tokio::test]
    #[serial(env)]
    async fn rotates_and_revokes_tokens() {
        let _sandbox = EnvSandbox::new();

        let created = add_local_client_token(Some("client"), Some(100)).await.unwrap();
        let rotated = rotate_local_client_token(&created.record.id, None, Some(200))
            .await
            .unwrap()
            .expect("rotation succeeds");
        assert!(rotated.plain_token.starts_with("cma_local_"));
        assert_eq!(rotated.record.label, "client");

        assert!(
            verify_local_client_bearer_token(
                Some(&format!("Bearer {}", created.plain_token)),
                Some(300),
            )
            .await
            .unwrap()
            .is_none()
        );
        let verified_rotated = verify_local_client_bearer_token(
            Some(&format!("Bearer {}", rotated.plain_token)),
            Some(300),
        )
        .await
        .unwrap();
        assert_eq!(
            verified_rotated.as_ref().map(|record| record.id.as_str()),
            Some(rotated.record.id.as_str())
        );

        assert!(revoke_local_client_token(&rotated.record.id, Some(400)).await.unwrap());
        assert!(
            verify_local_client_bearer_token(
                Some(&format!("Bearer {}", rotated.plain_token)),
                Some(500),
            )
            .await
            .unwrap()
            .is_none()
        );
        let store = load_local_client_token_store().await;
        assert_eq!(
            store
                .tokens
                .iter()
                .filter(|token| token.revoked_at.is_some())
                .count(),
            2
        );
        // Rotating or revoking an already-revoked token is refused.
        assert!(
            rotate_local_client_token(&rotated.record.id, None, Some(600))
                .await
                .unwrap()
                .is_none()
        );
        assert!(!revoke_local_client_token(&rotated.record.id, Some(600)).await.unwrap());
    }

    #[tokio::test]
    #[serial(env)]
    async fn debounces_last_used_at_persistence_across_rapid_verifies() {
        let _sandbox = EnvSandbox::new();

        let created = add_local_client_token(Some("hot-path"), Some(100)).await.unwrap();
        let bearer = format!("Bearer {}", created.plain_token);

        // Seed a persisted lastUsedAt so subsequent rapid verifies fall inside
        // the debounce window rather than the "never persisted" branch.
        verify_local_client_bearer_token(Some(&bearer), Some(1_000))
            .await
            .unwrap();

        // Every verify within the threshold stays in-memory: no write per
        // request on the auth hot path. (The TS test spies on fs.rename; the
        // observable here is the persisted value staying put.)
        for i in 1..=5 {
            let verified = verify_local_client_bearer_token(Some(&bearer), Some(1_000 + i))
                .await
                .unwrap()
                .expect("verifies");
            assert_eq!(verified.id, created.record.id);
            assert_eq!(verified.last_used_at, Some(1_000 + i));
        }

        // On disk it is still the last persisted value (debounced).
        let debounced = load_local_client_token_store().await;
        assert_eq!(debounced.tokens[0].last_used_at, Some(1_000));

        // Once past the threshold, the next verify flushes to disk.
        let flushed = verify_local_client_bearer_token(Some(&bearer), Some(1_000 + 60_000))
            .await
            .unwrap()
            .expect("verifies");
        assert_eq!(flushed.last_used_at, Some(1_000 + 60_000));

        let persisted = load_local_client_token_store().await;
        assert_eq!(persisted.tokens[0].last_used_at, Some(1_000 + 60_000));
    }

    #[tokio::test]
    #[serial(env)]
    async fn does_not_lose_mutations_when_revoke_and_add_run_concurrently() {
        let _sandbox = EnvSandbox::new();

        // Before the read-modify-write was serialized through the write
        // queue, add and revoke each loaded the same base store and the later
        // write clobbered the earlier one (lost update).
        let seeded = add_local_client_token(Some("seed"), Some(100)).await.unwrap();

        let (added, revoked) = tokio::join!(
            add_local_client_token(Some("added-concurrently"), Some(200)),
            revoke_local_client_token(&seeded.record.id, Some(300)),
        );
        added.unwrap();
        assert!(revoked.unwrap());

        let store = load_local_client_token_store().await;
        assert_eq!(store.tokens.len(), 2);
        let seed_record = store
            .tokens
            .iter()
            .find(|token| token.id == seeded.record.id)
            .expect("seed present");
        assert_eq!(seed_record.revoked_at, Some(300));
        let added_record = store
            .tokens
            .iter()
            .find(|token| token.label == "added-concurrently")
            .expect("concurrent add present");
        assert_eq!(added_record.revoked_at, None);
    }

    #[tokio::test]
    #[serial(env)]
    async fn load_fails_open_to_an_empty_store_on_corrupt_json() {
        let sandbox = EnvSandbox::new();
        let dir = sandbox.codex_multi_auth_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(TOKEN_FILE_NAME), "{ not json").unwrap();

        let store = load_local_client_token_store().await;
        assert_eq!(store, empty_store());
    }

    #[tokio::test]
    #[serial(env)]
    async fn normalize_drops_invalid_records_and_rejects_wrong_versions() {
        let _sandbox = EnvSandbox::new();
        // Wrong version ⇒ empty store.
        assert_eq!(
            normalize_store(&serde_json::json!({ "version": 2, "tokens": [] })),
            empty_store()
        );
        // Array root ⇒ empty store (isRecord contract).
        assert_eq!(normalize_store(&serde_json::json!([])), empty_store());
        // Records without id / with un-prefixed hashes are dropped; label,
        // prefix, and timestamps are normalized.
        let store = normalize_store(&serde_json::json!({
            "version": 1,
            "tokens": [
                { "id": "  keeper  ", "label": "  ", "prefix": 7, "tokenHash": "sha256:abc",
                  "createdAt": "soon", "lastUsedAt": 5, "revokedAt": null },
                { "id": "", "tokenHash": "sha256:abc" },
                { "id": "x", "tokenHash": "md5:nope" },
                "not-a-record"
            ]
        }));
        assert_eq!(store.tokens.len(), 1);
        let record = &store.tokens[0];
        assert_eq!(record.id, "keeper");
        assert_eq!(record.label, "local-client");
        assert_eq!(record.prefix, "");
        assert_eq!(record.created_at, 0);
        assert_eq!(record.last_used_at, Some(5));
        assert_eq!(record.revoked_at, None);
    }

    #[test]
    fn bearer_parsing_is_case_insensitive_and_trims() {
        assert_eq!(parse_bearer_token("Bearer abc").as_deref(), Some("abc"));
        assert_eq!(parse_bearer_token("bearer abc").as_deref(), Some("abc"));
        assert_eq!(parse_bearer_token("BEARER   abc  ").as_deref(), Some("abc"));
        assert_eq!(parse_bearer_token("Bearer\tabc").as_deref(), Some("abc"));
        assert_eq!(parse_bearer_token("Bearer"), None);
        assert_eq!(parse_bearer_token("Bearer "), None);
        assert_eq!(parse_bearer_token("Bearerabc"), None);
        assert_eq!(parse_bearer_token("Basic abc"), None);
        assert_eq!(parse_bearer_token("Bearer a\nb"), None);
        assert_eq!(parse_bearer_token(""), None);
    }

    #[test]
    fn plain_tokens_have_the_documented_shape() {
        let created = create_local_client_token_record(None, Some(0));
        // `cma_local_` + 43 chars of base64url(32 bytes) = 53 chars.
        assert_eq!(created.plain_token.len(), 53);
        assert!(created.plain_token.starts_with("cma_local_"));
        assert_eq!(created.record.prefix.len(), 18);
        assert_eq!(created.record.label, "local-client");
        assert_eq!(created.record.token_hash.len(), 7 + 64);
        assert_eq!(created.record.created_at, 0);
        assert_eq!(created.record.last_used_at, None);
        assert_eq!(created.record.revoked_at, None);
    }

    // ---- golden byte-compat gate ----

    #[test]
    fn golden_store_reserializes_byte_identically() {
        let raw = read_golden_string("local-client-tokens.json");
        let value: Value = serde_json::from_str(&raw).unwrap();
        let store = normalize_store(&value);
        assert_golden_str(
            "local-client-tokens.json",
            &format!("{}\n", stringify_pretty2(&store)),
        );
    }

    #[tokio::test]
    #[serial(env)]
    async fn save_writes_the_golden_bytes_to_disk() {
        let _sandbox = EnvSandbox::new();
        let store = LocalClientTokenStore {
            version: 1,
            tokens: vec![LocalClientTokenRecord {
                id: "00000000-0000-4000-8000-000000000001".to_string(),
                label: "workstation".to_string(),
                prefix: "cma_local_AAECAwQF".to_string(),
                token_hash:
                    "sha256:7de937f6bef93e60a3f6fa9074d756f2b62a7c0b9c5621cef751b47fdf84480f"
                        .to_string(),
                created_at: 1_750_000_000_000,
                last_used_at: None,
                revoked_at: None,
            }],
        };
        save_local_client_token_store(&store).await.unwrap();
        let written = std::fs::read_to_string(get_local_client_token_path()).unwrap();
        assert_golden_str("local-client-tokens.json", &written);
    }
}
