//! Port of `lib/routing-profiles.ts` — persisted per-project routing
//! profile store (`routing-profiles.json`): tag preferences, model
//! allow/deny lists, per-account weights, budget key.
//!
//! Behavior source: specs/03-accounts.md §8 (+ §11 constants, §13 error
//! contracts, §15 gotcha 23). TS source is authoritative.
//!
//! On-disk format (golden fixture
//! `crates/testkit/goldens/routing-profiles.json`):
//! `{ "version": 1, "profiles": { "<key>": { projectKey, projectName,
//! identityRoot, preferredTags, avoidTags, modelAllowlist, modelDenylist,
//! accountWeightByKey, budgetKey, updatedAt } } }` — 2-space pretty print,
//! trailing newline, 0600/0700 modes, field order as listed.
//!
//! Concurrency: same model as `account_policy.rs` — NO cross-process lock;
//! atomic temp+rename + in-process write queue; last writer wins.

use std::io;
use std::path::{Path, PathBuf};

use cma_core::fs_retry::{Backoff, RetryOptions, with_retry};
use cma_core::json_io::{
    TrailingNewline, WriteJsonOptions, stringify_pretty2, write_json_atomic,
};
use cma_core::logger::log_warn;
use cma_core::runtime_paths::get_codex_multi_auth_dir;
use cma_storage::paths::{
    find_project_root, get_project_storage_key, resolve_project_storage_identity_root,
};
use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};
use serde_json::Value;

/// TS `ROUTING_PROFILES_FILE_NAME`.
pub const ROUTING_PROFILES_FILE_NAME: &str = "routing-profiles.json";

const PROJECT_NAME_MAX_LEN_UTF16: usize = 80;
const BUDGET_KEY_MAX_LEN_UTF16: usize = 80;
const WEIGHT_MIN: f64 = 0.0;
const WEIGHT_MAX: f64 = 10.0;

/// Retryable read/rename codes (TS `RETRYABLE_FS_CODES`).
const RETRYABLE_FS_CODES: &[&str] = &["EBUSY", "EPERM"];

/// In-process write serialization (TS module-level `writeQueue`; see
/// `account_policy.rs` for the pattern rationale).
static WRITE_QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Ordered `Record<string, number>` with JS-object insertion semantics.
/// Keys MUST start `"sha256:"`; values are clamped `[0, 10]` on normalize.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AccountWeightMap {
    entries: Vec<(String, f64)>,
}

impl AccountWeightMap {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<f64> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, weight)| *weight)
    }

    /// JS `map[key] = weight`: replaces in place (keeping position) when the
    /// key exists, otherwise appends.
    pub fn insert(&mut self, key: impl Into<String>, weight: f64) {
        let key = key.into();
        if let Some(entry) = self.entries.iter_mut().find(|(k, _)| *k == key) {
            entry.1 = weight;
        } else {
            self.entries.push((key, weight));
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<f64> {
        let index = self.entries.iter().position(|(k, _)| k == key)?;
        Some(self.entries.remove(index).1)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, f64)> {
        self.entries.iter().map(|(k, weight)| (k.as_str(), *weight))
    }
}

impl Serialize for AccountWeightMap {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.entries.len()))?;
        for (key, weight) in &self.entries {
            map.serialize_entry(key, weight)?;
        }
        map.end()
    }
}

/// TS `interface RoutingProfile`. Field declaration order == on-disk
/// emission order (byte compat). `budgetKey` serializes as literal `null`
/// when absent.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingProfile {
    /// `"<sanitized-name≤40>-<12hex sha256>"` — forced to the map key on
    /// normalize.
    pub project_key: String,
    /// Trimmed, ≤80 UTF-16 units, fallback `"project"`.
    pub project_name: String,
    /// Worktree-resolved project root path (`""` when missing).
    pub identity_root: String,
    pub preferred_tags: Vec<String>,
    pub avoid_tags: Vec<String>,
    pub model_allowlist: Vec<String>,
    pub model_denylist: Vec<String>,
    pub account_weight_by_key: AccountWeightMap,
    /// Trimmed, ≤80 units, else `None` (serialized `null`).
    pub budget_key: Option<String>,
    /// Epoch ms, `0` when unknown.
    pub updated_at: f64,
}

/// TS `interface RoutingProfileStore` (`version` always the literal `1`).
/// `profiles` preserves JS-object insertion order.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RoutingProfileStore {
    entries: Vec<(String, RoutingProfile)>,
}

impl RoutingProfileStore {
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

    pub fn get(&self, key: &str) -> Option<&RoutingProfile> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, profile)| profile)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut RoutingProfile> {
        self.entries
            .iter_mut()
            .find(|(k, _)| k == key)
            .map(|(_, profile)| profile)
    }

    /// JS `store.profiles[key] = profile` (insertion-order preserving).
    pub fn insert(&mut self, key: impl Into<String>, profile: RoutingProfile) {
        let key = key.into();
        if let Some(entry) = self.entries.iter_mut().find(|(k, _)| *k == key) {
            entry.1 = profile;
        } else {
            self.entries.push((key, profile));
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &RoutingProfile)> {
        self.entries
            .iter()
            .map(|(k, profile)| (k.as_str(), profile))
    }
}

impl Serialize for RoutingProfileStore {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        struct Profiles<'a>(&'a [(String, RoutingProfile)]);
        impl Serialize for Profiles<'_> {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let mut map = serializer.serialize_map(Some(self.0.len()))?;
                for (key, profile) in self.0 {
                    map.serialize_entry(key, profile)?;
                }
                map.end()
            }
        }
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("version", &1)?;
        map.serialize_entry("profiles", &Profiles(&self.entries))?;
        map.end()
    }
}

/// TS `interface ProjectRoutingProfileContext`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectRoutingProfileContext {
    pub start_dir: PathBuf,
    pub project_root: Option<PathBuf>,
    pub identity_root: Option<PathBuf>,
    pub project_key: Option<String>,
    pub profile: Option<RoutingProfile>,
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/// JS `String.prototype.slice(0, n)` — see `account_policy.rs`.
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

/// JS default `.sort()` comparator (UTF-16 code-unit order).
fn js_string_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// TS `normalizeTokenList`: strings only, trim + lowercase, drop empty,
/// Set-dedupe, `.sort()`. (Unlike account-policy tags, NO charset
/// replacement — `"Team A"` becomes `"team a"`.)
fn normalize_token_list_iter<'a>(tokens: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for token in tokens {
        let normalized = token.trim().to_lowercase();
        if !normalized.is_empty() && !seen.contains(&normalized) {
            seen.push(normalized);
        }
    }
    seen.sort_by(|a, b| js_string_cmp(a, b));
    seen
}

fn normalize_token_list_value(value: Option<&Value>) -> Vec<String> {
    match value.and_then(Value::as_array) {
        Some(raw) => normalize_token_list_iter(raw.iter().filter_map(Value::as_str)),
        None => Vec::new(),
    }
}

/// TS `normalizeWeightMap`: keys must start `"sha256:"`, values finite,
/// clamped `[0, 10]`.
fn normalize_weight_map_value(value: Option<&Value>) -> AccountWeightMap {
    let mut result = AccountWeightMap::new();
    if let Some(record) = value.and_then(Value::as_object) {
        for (key, raw) in record {
            if !key.starts_with("sha256:") {
                continue;
            }
            let Some(weight) = raw.as_f64().filter(|w| w.is_finite()) else {
                continue;
            };
            result.insert(key.clone(), weight.clamp(WEIGHT_MIN, WEIGHT_MAX));
        }
    }
    result
}

fn normalize_weight_map_typed(map: &AccountWeightMap) -> AccountWeightMap {
    let mut result = AccountWeightMap::new();
    for (key, weight) in map.iter() {
        if !key.starts_with("sha256:") || !weight.is_finite() {
            continue;
        }
        result.insert(key.to_string(), weight.clamp(WEIGHT_MIN, WEIGHT_MAX));
    }
    result
}

fn normalize_project_name(value: Option<&str>) -> String {
    let trimmed = value.unwrap_or("").trim();
    if trimmed.is_empty() {
        "project".to_string()
    } else {
        slice_utf16_units(trimmed, PROJECT_NAME_MAX_LEN_UTF16)
    }
}

fn normalize_budget_key(value: Option<&str>) -> Option<String> {
    let trimmed = value.unwrap_or("").trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(slice_utf16_units(trimmed, BUDGET_KEY_MAX_LEN_UTF16))
    }
}

/// TS `normalizeProfile(key, value)` over a raw JSON value (load path) —
/// `None` when the value is not a record (the entry is dropped).
fn normalize_profile_value(key: &str, value: &Value) -> Option<RoutingProfile> {
    let record = value.as_object()?;
    Some(RoutingProfile {
        // TS: `value.projectKey` only when it string-equals `key`, else
        // forced to `key` — either way the result IS `key`.
        project_key: key.to_string(),
        project_name: normalize_project_name(record.get("projectName").and_then(Value::as_str)),
        identity_root: record
            .get("identityRoot")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("")
            .to_string(),
        preferred_tags: normalize_token_list_value(record.get("preferredTags")),
        avoid_tags: normalize_token_list_value(record.get("avoidTags")),
        model_allowlist: normalize_token_list_value(record.get("modelAllowlist")),
        model_denylist: normalize_token_list_value(record.get("modelDenylist")),
        account_weight_by_key: normalize_weight_map_value(record.get("accountWeightByKey")),
        budget_key: normalize_budget_key(record.get("budgetKey").and_then(Value::as_str)),
        updated_at: record
            .get("updatedAt")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .unwrap_or(0.0),
    })
}

/// TS `normalizeProfile` applied to a typed profile (save/upsert path). A
/// typed profile is always a record, so this never drops the entry.
fn normalize_profile_typed(key: &str, profile: &RoutingProfile) -> RoutingProfile {
    RoutingProfile {
        project_key: key.to_string(),
        project_name: normalize_project_name(Some(&profile.project_name)),
        identity_root: profile.identity_root.trim().to_string(),
        preferred_tags: normalize_token_list_iter(profile.preferred_tags.iter().map(String::as_str)),
        avoid_tags: normalize_token_list_iter(profile.avoid_tags.iter().map(String::as_str)),
        model_allowlist: normalize_token_list_iter(
            profile.model_allowlist.iter().map(String::as_str),
        ),
        model_denylist: normalize_token_list_iter(
            profile.model_denylist.iter().map(String::as_str),
        ),
        account_weight_by_key: normalize_weight_map_typed(&profile.account_weight_by_key),
        budget_key: normalize_budget_key(profile.budget_key.as_deref()),
        updated_at: if profile.updated_at.is_finite() {
            profile.updated_at
        } else {
            0.0
        },
    }
}

/// TS `normalizeStore(value)` over raw JSON (load path).
fn normalize_store_value(value: &Value) -> RoutingProfileStore {
    let Some(record) = value.as_object() else {
        return RoutingProfileStore::empty();
    };
    if record.get("version").and_then(Value::as_f64) != Some(1.0) {
        return RoutingProfileStore::empty();
    }
    let mut store = RoutingProfileStore::empty();
    if let Some(profiles) = record.get("profiles").and_then(Value::as_object) {
        for (key, raw) in profiles {
            if let Some(profile) = normalize_profile_value(key, raw) {
                store.insert(key.clone(), profile);
            }
        }
    }
    store
}

/// TS `normalizeStore` applied to a typed store (save path).
fn normalize_store_typed(store: &RoutingProfileStore) -> RoutingProfileStore {
    let mut normalized = RoutingProfileStore::empty();
    for (key, profile) in store.iter() {
        normalized.insert(key.to_string(), normalize_profile_typed(key, profile));
    }
    normalized
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

fn sidecar_backoff() -> Backoff {
    // TS `sleep(10 * 2 ** attempt)` (0-based) → 10/20/40/80 ms for the
    // 1-based failed-attempt index.
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

/// TS `getRoutingProfilesPath()`.
pub fn get_routing_profiles_path() -> PathBuf {
    get_codex_multi_auth_dir().join(ROUTING_PROFILES_FILE_NAME)
}

/// TS `loadRoutingProfileStore()` — NEVER fails (warn + empty store on any
/// read/parse problem).
pub async fn load_routing_profile_store() -> RoutingProfileStore {
    let path = get_routing_profiles_path();
    if !path.exists() {
        return RoutingProfileStore::empty();
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
                &format!("Failed to load routing profiles from {basename}: {message}"),
                None,
            );
            RoutingProfileStore::empty()
        }
    }
}

/// TS `saveRoutingProfileStore(store)` — identical atomic write-queue
/// pattern as `save_account_policy_store` (mkdir 0700, temp write 0600,
/// 2-space pretty + trailing `\n`, rename retried ×5 on EBUSY/EPERM, temp
/// unlinked on failure).
pub async fn save_routing_profile_store(store: &RoutingProfileStore) -> io::Result<()> {
    let path = get_routing_profiles_path();
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

/// Input for [`create_default_routing_profile`].
#[derive(Debug, Clone)]
pub struct DefaultRoutingProfileInput {
    pub project_key: String,
    pub project_name: String,
    pub identity_root: String,
    /// Epoch ms; `None` → caller-side `Date.now()` equivalent.
    pub now_ms: Option<i64>,
}

/// TS `createDefaultRoutingProfile(input)`.
pub fn create_default_routing_profile(input: DefaultRoutingProfileInput) -> RoutingProfile {
    RoutingProfile {
        project_key: input.project_key,
        project_name: input.project_name,
        identity_root: input.identity_root,
        preferred_tags: Vec::new(),
        avoid_tags: Vec::new(),
        model_allowlist: Vec::new(),
        model_denylist: Vec::new(),
        account_weight_by_key: AccountWeightMap::new(),
        budget_key: None,
        updated_at: input.now_ms.unwrap_or_else(cma_core::utils::now_ms) as f64,
    }
}

/// TS `upsertRoutingProfile(store, profile, mutate?, now)` without a mutate
/// callback.
pub fn upsert_routing_profile(
    store: &mut RoutingProfileStore,
    profile: &RoutingProfile,
    now_ms: i64,
) -> RoutingProfile {
    upsert_routing_profile_with(store, profile, |_| {}, now_ms)
}

/// TS `upsertRoutingProfile(store, profile, mutate, now)` — clone the
/// stored (or given) profile, apply `mutate`, stamp `updatedAt`, then fully
/// re-normalize under `profile.projectKey`.
///
/// The TS `throw new Error("Invalid routing profile")` branch fired only
/// when `mutate` replaced the object with a non-record — unrepresentable in
/// Rust, so this function is infallible.
pub fn upsert_routing_profile_with(
    store: &mut RoutingProfileStore,
    profile: &RoutingProfile,
    mutate: impl FnOnce(&mut RoutingProfile),
    now_ms: i64,
) -> RoutingProfile {
    let mut next = store
        .get(&profile.project_key)
        .cloned()
        .unwrap_or_else(|| profile.clone());
    mutate(&mut next);
    next.updated_at = now_ms as f64;
    let normalized = normalize_profile_typed(&profile.project_key, &next);
    store.insert(profile.project_key.clone(), normalized.clone());
    normalized
}

/// TS `resolveProjectRoutingProfile(startDir, storeLoader?)` with the
/// default loader.
pub async fn resolve_project_routing_profile(start_dir: &Path) -> ProjectRoutingProfileContext {
    resolve_project_routing_profile_with_loader(start_dir, load_routing_profile_store()).await
}

/// Loader-injectable variant (TS `storeLoader` default parameter). The
/// loader future is only awaited when a project root is found — the TS
/// short-circuits before touching the store.
pub async fn resolve_project_routing_profile_with_loader(
    start_dir: &Path,
    store_loader: impl Future<Output = RoutingProfileStore>,
) -> ProjectRoutingProfileContext {
    let Some(project_root) = find_project_root(start_dir) else {
        return ProjectRoutingProfileContext {
            start_dir: start_dir.to_path_buf(),
            project_root: None,
            identity_root: None,
            project_key: None,
            profile: None,
        };
    };
    let identity_root = resolve_project_storage_identity_root(&project_root);
    let project_key = get_project_storage_key(&identity_root);
    let store = store_loader.await;
    let profile = store.get(&project_key).cloned();
    ProjectRoutingProfileContext {
        start_dir: start_dir.to_path_buf(),
        project_root: Some(project_root),
        identity_root: Some(identity_root),
        project_key: Some(project_key),
        profile,
    }
}

/// TS `resetRoutingProfileWriteQueueForTests()` — parity no-op (see
/// `reset_account_policy_write_queue_for_tests`).
pub fn reset_routing_profile_write_queue_for_tests() {}

// ---------------------------------------------------------------------------
// Tests (ported from test/routing-profiles.test.ts + golden round-trip)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    #[test]
    fn token_lists_lowercase_trim_dedupe_and_sort_without_charset_rewrite() {
        assert_eq!(
            normalize_token_list_iter(["  Team A ", "team a", "B!"].into_iter()),
            vec!["b!", "team a"],
        );
        assert_eq!(normalize_token_list_iter(["   ", ""].into_iter()), Vec::<String>::new());
    }

    #[test]
    fn weight_maps_drop_foreign_keys_and_clamp() {
        let value = serde_json::json!({
            "sha256:aa": 12,
            "sha256:bb": -1,
            "sha256:cc": 0.5,
            "plain": 3,
            "sha256:dd": "9"
        });
        let map = normalize_weight_map_value(Some(&value));
        assert_eq!(map.len(), 3);
        assert_eq!(map.get("sha256:aa"), Some(10.0));
        assert_eq!(map.get("sha256:bb"), Some(0.0));
        assert_eq!(map.get("sha256:cc"), Some(0.5));
        assert_eq!(map.get("plain"), None);
        assert_eq!(map.get("sha256:dd"), None);
    }

    #[test]
    fn profile_normalization_defaults_and_caps() {
        let value = serde_json::json!({
            "projectKey": "other-key",
            "projectName": "   ",
            "identityRoot": "  /x  ",
            "budgetKey": "",
            "updatedAt": "not-a-number"
        });
        let profile = normalize_profile_value("the-key", &value).unwrap();
        assert_eq!(profile.project_key, "the-key");
        assert_eq!(profile.project_name, "project");
        assert_eq!(profile.identity_root, "/x");
        assert_eq!(profile.budget_key, None);
        assert_eq!(profile.updated_at, 0.0);
        // Non-record entries are dropped entirely.
        assert!(normalize_profile_value("k", &serde_json::json!(42)).is_none());
    }

    #[tokio::test]
    #[serial(env)]
    async fn resolves_profile_identity_through_project_storage_helpers() {
        let sandbox = EnvSandbox::new();
        let project_dir = sandbox.root().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(project_dir.join("package.json"), "{}").unwrap();

        let initial = resolve_project_routing_profile(&project_dir).await;
        assert_eq!(initial.project_root.as_deref(), Some(project_dir.as_path()));
        assert_eq!(initial.identity_root.as_deref(), Some(project_dir.as_path()));
        let project_key = initial.project_key.clone().unwrap();
        assert!(project_key.starts_with("project-"), "got {project_key}");
        assert!(initial.profile.is_none());

        let mut store = load_routing_profile_store().await;
        let profile = create_default_routing_profile(DefaultRoutingProfileInput {
            project_key: project_key.clone(),
            project_name: "project".to_string(),
            identity_root: project_dir.to_string_lossy().into_owned(),
            now_ms: Some(100),
        });
        upsert_routing_profile_with(
            &mut store,
            &profile,
            |next| {
                next.preferred_tags.push("Team A".to_string());
                next.model_allowlist.push("GPT-5.3-Codex".to_string());
                next.account_weight_by_key.insert("sha256:abc", 3.0);
                next.budget_key = Some("default".to_string());
            },
            200,
        );
        save_routing_profile_store(&store).await.unwrap();

        let resolved = resolve_project_routing_profile(&project_dir).await;
        let profile = resolved.profile.unwrap();
        assert_eq!(profile.project_key, project_key);
        assert_eq!(profile.preferred_tags, vec!["team a"]);
        assert_eq!(profile.model_allowlist, vec!["gpt-5.3-codex"]);
        assert_eq!(profile.account_weight_by_key.get("sha256:abc"), Some(3.0));
        assert_eq!(profile.budget_key.as_deref(), Some("default"));
        assert_eq!(profile.updated_at, 200.0);
    }

    #[tokio::test]
    #[serial(env)]
    async fn returns_null_profile_when_none_stored_for_project() {
        let sandbox = EnvSandbox::new();
        let project_dir = sandbox.root().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(project_dir.join("package.json"), "{}").unwrap();

        let context = resolve_project_routing_profile(&project_dir).await;
        assert!(context.project_key.unwrap().starts_with("project-"));
        assert!(context.profile.is_none());
    }

    #[tokio::test]
    #[serial(env)]
    async fn golden_routing_profiles_round_trips_byte_exact() {
        let sandbox = EnvSandbox::new();
        let golden_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../testkit/goldens/routing-profiles.json"
        );
        let golden = std::fs::read_to_string(golden_path).unwrap();
        std::fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
        std::fs::write(get_routing_profiles_path(), &golden).unwrap();

        let store = load_routing_profile_store().await;
        assert_eq!(store.len(), 1);
        // Golden carries fractional weights (0.5) — must survive.
        assert_eq!(
            store
                .get("my-app-0123456789ab")
                .unwrap()
                .account_weight_by_key
                .iter()
                .map(|(_, w)| w)
                .collect::<Vec<_>>(),
            vec![2.0, 0.5],
        );
        save_routing_profile_store(&store).await.unwrap();

        let rewritten = std::fs::read_to_string(get_routing_profiles_path()).unwrap();
        assert_eq!(rewritten, golden, "canonical file must round-trip byte-exact");
    }
}
