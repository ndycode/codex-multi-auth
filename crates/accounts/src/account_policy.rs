//! Port of `lib/account-policy.ts` — persisted per-account policy store.
//!
//! Behavior source: specs/03-accounts.md §3 (+ §11 constants, §13 error
//! contracts, §15 gotchas 22–23). TS source is authoritative.
//!
//! On-disk format (`<multiAuthDir>/account-policies.json`, golden fixture
//! `crates/testkit/goldens/account-policies.json`):
//! `{ "version": 1, "accounts": { "sha256:<64hex>": { accountKey, tags,
//! weight, paused, drained, note, updatedAt } } }` — 2-space pretty print,
//! trailing newline, file mode 0600, dir 0700, field order as listed, map
//! insertion order preserved.
//!
//! Concurrency: NO cross-process lock — atomic temp+rename plus an
//! in-process write queue (module promise chain in TS; a static tokio
//! `Mutex` here). Last writer wins across processes (spec §14).

use std::io;
use std::path::{Path, PathBuf};

use cma_core::fs_retry::{Backoff, RetryOptions, with_retry};
use cma_core::json_io::{
    TrailingNewline, WriteJsonOptions, stringify_pretty2, write_json_atomic,
};
use cma_core::logger::log_warn;
use cma_core::runtime_paths::get_codex_multi_auth_dir;
use cma_storage::identity::AccountIdentityLike;
use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// TS `ACCOUNT_POLICY_FILE_NAME`.
pub const ACCOUNT_POLICY_FILE_NAME: &str = "account-policies.json";

const TAG_MAX_LEN_UTF16: usize = 64;
const NOTE_MAX_LEN_UTF16: usize = 500;
const WEIGHT_MIN: f64 = 0.0;
const WEIGHT_MAX: f64 = 10.0;
const WEIGHT_DEFAULT: f64 = 1.0;

/// Retryable read/rename codes (TS `RETRYABLE_FS_CODES`).
const RETRYABLE_FS_CODES: &[&str] = &["EBUSY", "EPERM"];

/// In-process write serialization (TS module-level `writeQueue` promise
/// chain; tokio's Mutex is FIFO-fair, and a failed task never poisons the
/// queue — matching the `.catch(() => undefined)` chain reset).
static WRITE_QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// TS `interface AccountPolicy`. Field declaration order == on-disk emission
/// order (byte compat). `note` serializes as literal `null` when absent
/// (TS always emits the key).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPolicy {
    /// `"sha256:<64 hex>"` — forced to the map key on normalize.
    pub account_key: String,
    /// Normalized, deduped, sorted.
    pub tags: Vec<String>,
    /// Clamped to `[0, 10]`, default `1`.
    pub weight: f64,
    /// Hard block (request-policy layer excludes the account).
    pub paused: bool,
    /// Soft drain (no new sessions).
    pub drained: bool,
    /// Trimmed, max 500 UTF-16 units; `None` serializes as `null`.
    pub note: Option<String>,
    /// Epoch ms, `0` when unknown.
    pub updated_at: f64,
}

/// TS `interface AccountPolicyStore` (`version` is always the literal `1`;
/// the Rust type omits the field and the serializer emits it).
///
/// `accounts` preserves JS-object insertion order: re-assigning an existing
/// key keeps its position; new keys append.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AccountPolicyStore {
    entries: Vec<(String, AccountPolicy)>,
}

impl AccountPolicyStore {
    /// TS `emptyStore()`.
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&AccountPolicy> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, policy)| policy)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut AccountPolicy> {
        self.entries
            .iter_mut()
            .find(|(k, _)| k == key)
            .map(|(_, policy)| policy)
    }

    /// JS `store.accounts[key] = policy`: replaces in place (keeping
    /// position) when the key exists, otherwise appends.
    pub fn insert(&mut self, key: impl Into<String>, policy: AccountPolicy) {
        let key = key.into();
        if let Some(entry) = self.entries.iter_mut().find(|(k, _)| *k == key) {
            entry.1 = policy;
        } else {
            self.entries.push((key, policy));
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &AccountPolicy)> {
        self.entries
            .iter()
            .map(|(k, policy)| (k.as_str(), policy))
    }
}

impl Serialize for AccountPolicyStore {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        struct Accounts<'a>(&'a [(String, AccountPolicy)]);
        impl Serialize for Accounts<'_> {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let mut map = serializer.serialize_map(Some(self.0.len()))?;
                for (key, policy) in self.0 {
                    map.serialize_entry(key, policy)?;
                }
                map.end()
            }
        }
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("version", &1)?;
        map.serialize_entry("accounts", &Accounts(&self.entries))?;
        map.end()
    }
}

// ---------------------------------------------------------------------------
// Normalization (must match TS byte-for-byte on re-save)
// ---------------------------------------------------------------------------

/// JS `String.prototype.slice(0, n)` — cuts at `n` UTF-16 code units, never
/// splitting a surrogate pair (a split pair would be a lone surrogate in JS;
/// unrepresentable in Rust, so the whole char is dropped instead).
fn slice_utf16_units(value: &str, max_units: usize) -> String {
    let mut units = 0usize;
    let mut end = value.len();
    for (idx, ch) in value.char_indices() {
        let width = ch.len_utf16();
        if units + width > max_units {
            end = idx;
            break;
        }
        units += width;
    }
    value[..end].to_string()
}

/// JS default `Array.prototype.sort()` comparator over strings — UTF-16
/// code-unit lexicographic order (differs from Rust's UTF-8 byte order only
/// for astral-vs-BMP mixes, but stay exact).
fn js_string_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// TS `normalizeTag`: trim, lowercase, collapse runs of `[^a-z0-9._-]` to a
/// single `-`; empty → `None`; capped at 64 units.
fn normalize_tag(value: &str) -> Option<String> {
    let lowered = value.trim().to_lowercase();
    let mut normalized = String::with_capacity(lowered.len());
    let mut in_run = false;
    for ch in lowered.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-') {
            normalized.push(ch);
            in_run = false;
        } else if !in_run {
            normalized.push('-');
            in_run = true;
        }
    }
    if normalized.is_empty() {
        None
    } else {
        Some(slice_utf16_units(&normalized, TAG_MAX_LEN_UTF16))
    }
}

/// TS `normalizeWeight`: finite number → clamp `[0, 10]`, else `1`.
fn normalize_weight(value: Option<f64>) -> f64 {
    match value {
        Some(v) if v.is_finite() => v.clamp(WEIGHT_MIN, WEIGHT_MAX),
        _ => WEIGHT_DEFAULT,
    }
}

/// Shared tag-list canonicalization: per-tag normalize, drop `None`s,
/// Set-dedupe, JS-`.sort()`.
fn normalize_tag_list<'a>(tags: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for tag in tags {
        if let Some(normalized) = normalize_tag(tag)
            && !seen.contains(&normalized)
        {
            seen.push(normalized);
        }
    }
    seen.sort_by(|a, b| js_string_cmp(a, b));
    seen
}

fn normalize_note(note: Option<&str>) -> Option<String> {
    let trimmed = note.unwrap_or("").trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(slice_utf16_units(trimmed, NOTE_MAX_LEN_UTF16))
    }
}

/// TS `normalizePolicy(key, value)` over a raw JSON value (load path).
/// Non-record → all defaults.
fn normalize_policy_value(key: &str, value: Option<&Value>) -> AccountPolicy {
    let record = value.and_then(Value::as_object);
    let tags = match record.and_then(|r| r.get("tags")).and_then(Value::as_array) {
        Some(raw) => normalize_tag_list(raw.iter().filter_map(Value::as_str)),
        None => Vec::new(),
    };
    let note = normalize_note(record.and_then(|r| r.get("note")).and_then(Value::as_str));
    AccountPolicy {
        account_key: key.to_string(),
        tags,
        weight: normalize_weight(record.and_then(|r| r.get("weight")).and_then(Value::as_f64)),
        paused: record.and_then(|r| r.get("paused")) == Some(&Value::Bool(true)),
        drained: record.and_then(|r| r.get("drained")) == Some(&Value::Bool(true)),
        note,
        updated_at: record
            .and_then(|r| r.get("updatedAt"))
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .unwrap_or(0.0),
    }
}

/// TS `normalizePolicy` applied to an in-memory typed policy (save path —
/// the TS ran the same function over the live object).
fn normalize_policy_typed(key: &str, policy: &AccountPolicy) -> AccountPolicy {
    AccountPolicy {
        account_key: key.to_string(),
        tags: normalize_tag_list(policy.tags.iter().map(String::as_str)),
        weight: normalize_weight(Some(policy.weight)),
        paused: policy.paused,
        drained: policy.drained,
        note: normalize_note(policy.note.as_deref()),
        updated_at: if policy.updated_at.is_finite() {
            policy.updated_at
        } else {
            0.0
        },
    }
}

/// TS `normalizeStore(value)` over raw JSON (load path). Not a record or
/// `version !== 1` → empty store; only `sha256:`-prefixed keys survive.
fn normalize_store_value(value: &Value) -> AccountPolicyStore {
    let Some(record) = value.as_object() else {
        return AccountPolicyStore::empty();
    };
    // JS `value.version !== 1` — both int `1` and float `1.0` compare equal.
    if record.get("version").and_then(Value::as_f64) != Some(1.0) {
        return AccountPolicyStore::empty();
    }
    let mut store = AccountPolicyStore::empty();
    if let Some(accounts) = record.get("accounts").and_then(Value::as_object) {
        for (key, raw) in accounts {
            if key.starts_with("sha256:") {
                store.insert(key.clone(), normalize_policy_value(key, Some(raw)));
            }
        }
    }
    store
}

/// TS `normalizeStore` applied to a typed store (save path).
fn normalize_store_typed(store: &AccountPolicyStore) -> AccountPolicyStore {
    let mut normalized = AccountPolicyStore::empty();
    for (key, policy) in store.iter() {
        if key.starts_with("sha256:") {
            normalized.insert(key.to_string(), normalize_policy_typed(key, policy));
        }
    }
    normalized
}

// ---------------------------------------------------------------------------
// Shared IO helpers (identical pattern in routing_profiles.rs)
// ---------------------------------------------------------------------------

fn sidecar_backoff() -> Backoff {
    // TS `sleep(10 * 2 ** attempt)` with a 0-based attempt index — for the
    // 1-based failed-attempt index n this is 10·2^(n-1) → 10/20/40/80 ms.
    Backoff::from_fn(|failed_attempt| {
        10u64.saturating_mul(2u64.saturating_pow(failed_attempt.saturating_sub(1)))
    })
}

/// TS `readFileWithRetry` — 5 attempts, EBUSY/EPERM only.
async fn read_file_with_retry(path: &Path) -> io::Result<String> {
    with_retry(
        || async { tokio::fs::read_to_string(path).await },
        RetryOptions::<io::Error>::new(5, sidecar_backoff()).with_codes(RETRYABLE_FS_CODES),
    )
    .await
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// TS `getAccountPolicyPath()`.
pub fn get_account_policy_path() -> PathBuf {
    get_codex_multi_auth_dir().join(ACCOUNT_POLICY_FILE_NAME)
}

/// TS `getAccountPolicyKey(account, _index?)` — `_index` is accepted and
/// IGNORED (mutable indexes must never become identity; spec gotcha 22).
/// Only `accountId`/`email` participate: id wins, else lowercased email,
/// else `"unknown"` (all id-less+email-less accounts collapse to one key).
pub fn get_account_policy_key(account: &impl AccountIdentityLike, _index: usize) -> String {
    get_account_policy_key_from_parts(account.identity_account_id(), account.identity_email())
}

/// [`get_account_policy_key`] over raw identity parts (for callers holding
/// live-pool accounts rather than storage rows).
pub fn get_account_policy_key_from_parts(
    account_id: Option<&str>,
    email: Option<&str>,
) -> String {
    let account_id = account_id.map(str::trim).unwrap_or("");
    let email_key;
    let identity = if !account_id.is_empty() {
        account_id
    } else {
        email_key = email.map(|e| e.trim().to_lowercase()).unwrap_or_default();
        if email_key.is_empty() { "unknown" } else { &email_key }
    };
    let digest = Sha256::digest(identity.as_bytes());
    let mut hex = String::with_capacity(7 + digest.len() * 2);
    hex.push_str("sha256:");
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// TS `loadAccountPolicyStore()` — NEVER fails: missing file, unreadable
/// file, malformed JSON, or a wrong-shape payload all yield an empty store
/// (unreadable/malformed additionally warn).
pub async fn load_account_policy_store() -> AccountPolicyStore {
    let path = get_account_policy_path();
    if !path.exists() {
        return AccountPolicyStore::empty();
    }
    let parsed: Result<Value, String> = match read_file_with_retry(&path).await {
        Ok(raw) => serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    match parsed {
        Ok(value) => normalize_store_value(&value),
        Err(message) => {
            let basename = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            log_warn(
                &format!("Failed to load account policies from {basename}: {message}"),
                None,
            );
            AccountPolicyStore::empty()
        }
    }
}

/// TS `saveAccountPolicyStore(store)` — normalize, then queue an atomic
/// temp+rename write (dir 0700, file 0600, 2-space pretty + trailing `\n`,
/// rename retried ×5 on EBUSY/EPERM, temp unlinked on failure). The awaited
/// task surfaces its own error; queue-level failures never poison later
/// writes.
pub async fn save_account_policy_store(store: &AccountPolicyStore) -> io::Result<()> {
    let path = get_account_policy_path();
    let payload = normalize_store_typed(store);
    let content = stringify_pretty2(&payload);
    let _queue = WRITE_QUEUE.lock().await;
    write_json_atomic(
        &path,
        &content,
        Some(0o600),
        &WriteJsonOptions {
            trailing_newline: TrailingNewline::Lf,
            ensure_parent_dir: true,
            parent_dir_mode: Some(0o700),
            rename_max_attempts: 5,
            ..Default::default()
        },
    )
    .await
}

/// TS `upsertAccountPolicy(store, accountKey, mutate, now)` — clone the
/// existing (or default) policy, apply `mutate`, then re-normalize ONLY
/// `tags` + `weight` and stamp `updatedAt` (note/paused/drained are
/// re-normalized at save/load, and `accountKey` stays whatever `mutate`
/// left).
pub fn upsert_account_policy(
    store: &mut AccountPolicyStore,
    account_key: &str,
    mutate: impl FnOnce(&mut AccountPolicy),
    now_ms: i64,
) -> AccountPolicy {
    let mut next = store
        .get(account_key)
        .cloned()
        .unwrap_or_else(|| normalize_policy_value(account_key, None));
    mutate(&mut next);
    next.tags = normalize_tag_list(next.tags.iter().map(String::as_str));
    next.weight = normalize_weight(Some(next.weight));
    next.updated_at = now_ms as f64;
    store.insert(account_key.to_string(), next.clone());
    next
}

/// TS `normalizeAccountPolicyTag` — public alias of the tag normalizer.
pub fn normalize_account_policy_tag(value: &str) -> Option<String> {
    normalize_tag(value)
}

/// TS `resetAccountPolicyWriteQueueForTests()` — the tokio-Mutex queue has
/// no failed-chain state to reset, so this is a parity no-op.
pub fn reset_account_policy_write_queue_for_tests() {}

// ---------------------------------------------------------------------------
// Tests (ported from test/account-policy.test.ts + golden byte round-trip)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    #[test]
    fn normalize_tag_matches_ts_charset_rules() {
        assert_eq!(normalize_tag("  Team A  "), Some("team-a".to_string()));
        assert_eq!(normalize_tag("Fast!!Lane"), Some("fast-lane".to_string()));
        assert_eq!(normalize_tag("a.b_c-d"), Some("a.b_c-d".to_string()));
        assert_eq!(normalize_tag("   "), None);
        assert_eq!(normalize_tag(""), None);
        // Runs of invalid characters collapse to ONE dash.
        assert_eq!(normalize_tag("x@# $y"), Some("x-y".to_string()));
        // 64-unit cap.
        let long = "a".repeat(100);
        assert_eq!(normalize_tag(&long).unwrap().len(), 64);
    }

    #[test]
    fn normalize_weight_clamps_and_defaults() {
        assert_eq!(normalize_weight(Some(5.0)), 5.0);
        assert_eq!(normalize_weight(Some(-3.0)), 0.0);
        assert_eq!(normalize_weight(Some(11.5)), 10.0);
        assert_eq!(normalize_weight(Some(f64::NAN)), 1.0);
        assert_eq!(normalize_weight(Some(f64::INFINITY)), 1.0);
        assert_eq!(normalize_weight(None), 1.0);
        assert_eq!(normalize_weight(Some(0.5)), 0.5);
    }

    #[test]
    fn policy_key_ignores_indexes_and_collapses_unidentified_accounts() {
        // TS: "does not use mutable account indexes as policy identity".
        let unidentified = cma_storage::identity::AccountIdentityRef::from_parts(None, None, None);
        assert_eq!(
            get_account_policy_key(&unidentified, 0),
            get_account_policy_key(&unidentified, 4),
        );
        let a = get_account_policy_key_from_parts(None, None);
        let b = get_account_policy_key_from_parts(Some("  "), Some(""));
        assert_eq!(a, b);
        assert_eq!(a, get_account_policy_key(&unidentified, 0));
        assert!(a.starts_with("sha256:"));
        assert_eq!(a.len(), "sha256:".len() + 64);
        // accountId wins over email; email lowercased.
        assert_eq!(
            get_account_policy_key_from_parts(None, Some("  Owner@Example.COM ")),
            get_account_policy_key_from_parts(None, Some("owner@example.com")),
        );
        assert_ne!(
            get_account_policy_key_from_parts(Some("acct_1"), Some("owner@example.com")),
            get_account_policy_key_from_parts(None, Some("owner@example.com")),
        );
    }

    #[test]
    fn normalize_store_value_drops_bad_versions_and_foreign_keys() {
        let value: Value = serde_json::json!({
            "version": 2,
            "accounts": { "sha256:aa": { "weight": 3 } }
        });
        assert!(normalize_store_value(&value).is_empty());

        let value: Value = serde_json::json!({
            "version": 1,
            "accounts": {
                "sha256:aa": { "weight": 3, "tags": ["B", "a", "b"], "paused": 1 },
                "plain-key": { "weight": 9 }
            }
        });
        let store = normalize_store_value(&value);
        assert_eq!(store.len(), 1);
        let policy = store.get("sha256:aa").unwrap();
        assert_eq!(policy.weight, 3.0);
        assert_eq!(policy.tags, vec!["a", "b"]);
        // paused must be literal true, not merely truthy.
        assert!(!policy.paused);
        assert_eq!(policy.note, None);
        assert_eq!(policy.updated_at, 0.0);
        assert_eq!(policy.account_key, "sha256:aa");
    }

    #[tokio::test]
    #[serial(env)]
    async fn stores_policy_rows_by_hashed_account_identity() {
        let _sandbox = EnvSandbox::new();
        let key =
            get_account_policy_key_from_parts(Some("acct_sensitive"), Some("owner@example.com"));
        let mut store = load_account_policy_store().await;
        upsert_account_policy(
            &mut store,
            &key,
            |policy| {
                policy.tags.push("Team A".to_string());
                policy.weight = 2.0;
                policy.paused = true;
                policy.note = Some("local note".to_string());
            },
            123,
        );
        save_account_policy_store(&store).await.unwrap();

        let raw = std::fs::read_to_string(get_account_policy_path()).unwrap();
        assert!(raw.contains("team-a"));
        assert!(!raw.contains("acct_sensitive"));
        assert!(!raw.contains("owner@example.com"));
        assert!(raw.ends_with('\n'));

        let loaded = load_account_policy_store().await;
        let policy = loaded.get(&key).unwrap();
        assert_eq!(policy.tags, vec!["team-a"]);
        assert_eq!(policy.weight, 2.0);
        assert!(policy.paused);
        assert!(!policy.drained);
        assert_eq!(policy.note.as_deref(), Some("local note"));
        assert_eq!(policy.updated_at, 123.0);
    }

    #[tokio::test]
    #[serial(env)]
    async fn missing_file_loads_as_empty_store() {
        let _sandbox = EnvSandbox::new();
        assert!(load_account_policy_store().await.is_empty());
    }

    #[tokio::test]
    #[serial(env)]
    async fn malformed_json_warns_and_loads_empty() {
        let sandbox = EnvSandbox::new();
        std::fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
        std::fs::write(get_account_policy_path(), "{oops").unwrap();
        assert!(load_account_policy_store().await.is_empty());
    }

    #[tokio::test]
    #[serial(env)]
    async fn golden_account_policies_round_trips_byte_exact() {
        let sandbox = EnvSandbox::new();
        let golden_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../testkit/goldens/account-policies.json"
        );
        let golden = std::fs::read_to_string(golden_path).unwrap();
        std::fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
        std::fs::write(get_account_policy_path(), &golden).unwrap();

        let store = load_account_policy_store().await;
        assert_eq!(store.len(), 2);
        save_account_policy_store(&store).await.unwrap();

        let rewritten = std::fs::read_to_string(get_account_policy_path()).unwrap();
        assert_eq!(rewritten, golden, "canonical file must round-trip byte-exact");
    }

    #[test]
    fn upsert_renormalizes_tags_and_weight_but_not_note() {
        let mut store = AccountPolicyStore::empty();
        let policy = upsert_account_policy(
            &mut store,
            "sha256:aa",
            |p| {
                p.tags = vec!["Zed!".into(), "alpha".into(), "alpha".into()];
                p.weight = 42.0;
                // note is NOT re-normalized inside upsert — only at save/load.
                p.note = Some("   ".into());
            },
            777,
        );
        assert_eq!(policy.tags, vec!["alpha", "zed-"]);
        assert_eq!(policy.weight, 10.0);
        assert_eq!(policy.note.as_deref(), Some("   "));
        assert_eq!(policy.updated_at, 777.0);
        assert_eq!(store.get("sha256:aa"), Some(&policy));
        // Save-path normalization then trims the note away.
        let normalized = normalize_store_typed(&store);
        assert_eq!(normalized.get("sha256:aa").unwrap().note, None);
    }
}
