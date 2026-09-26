//! Port of `lib/update-notice.ts` — npm-registry update check with a 24h
//! on-disk cache (`<cache-dir>/update-check-cache.json`).
//!
//! Byte contract: the cache is `JSON.stringify(cache, null, 2)` with **no
//! trailing newline** (golden: `update-check-cache.json`); `latestVersion`
//! serializes as JSON `null` when a fetch failed (failures are cached for
//! 24h too); `clearUpdateCache` overwrites the file with the literal `{}`.
//!
//! Deviations from TS (recorded in the port notes):
//! - `CACHE_DIR` was computed once at module load in TS; here it is derived
//!   per call from `get_codex_cache_dir()` so the env sandbox works. In
//!   production the env never changes mid-process, so behavior is identical.
//! - The module-level promise write queue is a process-global mutex; retry
//!   delays block the locking thread (bounded: 15+30+60 ms worst case).
//! - `getCurrentVersion` walks up from the running executable's directory
//!   (the TS walked from the compiled module dir) looking for the
//!   `codex-multi-auth` package.json.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use cma_core::fs_retry::code_of;
use cma_core::json_io::stringify_pretty2;
use cma_core::logger::{ScopedLogger, create_logger};
use cma_core::runtime_paths::get_codex_cache_dir;
use cma_core::temp_path::temp_path_for;
use cma_core::utils::now_ms;
use serde::Serialize;
use serde_json::{Value, json};

const PACKAGE_NAME: &str = "codex-multi-auth";
const NPM_REGISTRY_URL: &str = "https://registry.npmjs.org/codex-multi-auth/latest";
const CACHE_FILE_NAME: &str = "update-check-cache.json";
const CHECK_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS: u64 = 5_000;
/// Narrower than fs-retry's shared set: no EAGAIN/EACCES.
const RETRYABLE_WRITE_ERRORS: [&str; 3] = ["EBUSY", "EPERM", "ENOTEMPTY"];

/// Serializes cache writes within the process (TS `updateCacheWriteQueue`).
static UPDATE_CACHE_WRITE_QUEUE: Mutex<()> = Mutex::new(());

fn logger() -> ScopedLogger {
    create_logger("update-notice")
}

fn cache_file() -> PathBuf {
    get_codex_cache_dir().join(CACHE_FILE_NAME)
}

/// On-disk cache shape (`lastCheck` / `latestVersion` / `currentVersion`).
/// `latest_version` must serialize as literal `null` when absent — no skip.
#[derive(Clone, Debug, Serialize)]
struct UpdateCheckCache {
    #[serde(rename = "lastCheck")]
    last_check: i64,
    #[serde(rename = "latestVersion")]
    latest_version: Option<String>,
    #[serde(rename = "currentVersion")]
    current_version: String,
}

/// Leniently-read cache (the TS cast the parsed JSON without validation; a
/// cleared `{}` cache parses fine and every field reads as absent).
struct LoadedCache {
    last_check: Option<f64>,
    latest_version: Option<String>,
    current_version: Option<String>,
}

/// TS `UpdateCheckResult`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateCheckResult {
    pub has_update: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    /// Always `"npm install -g codex-multi-auth@latest"`.
    pub update_command: String,
}

/// TS `writeCacheContents(serialized)` — mkdir, temp write + rename, up to 4
/// attempts with 15/30/60 ms delays on EBUSY/EPERM/ENOTEMPTY; best-effort
/// temp unlink after a final failure.
fn write_cache_contents(serialized: &str) -> std::io::Result<()> {
    let cache_dir = get_codex_cache_dir();
    let cache_path = cache_file();
    let mut temp_path: Option<PathBuf> = None;
    let mut wrote_temp = false;
    let result = (|| {
        if !cache_dir.exists() {
            std::fs::create_dir_all(&cache_dir)?;
        }
        let temp = temp_path_for(&cache_path);
        temp_path = Some(temp.clone());
        let mut last_error: Option<std::io::Error> = None;
        for attempt in 0..4u32 {
            let step = std::fs::write(&temp, serialized)
                .and_then(|()| std::fs::rename(&temp, &cache_path));
            match step {
                Ok(()) => {
                    wrote_temp = false;
                    return Ok(());
                }
                Err(error) => {
                    let code = code_of(&error).unwrap_or("");
                    wrote_temp = true;
                    let retryable = RETRYABLE_WRITE_ERRORS.contains(&code);
                    if !retryable || attempt >= 3 {
                        return Err(error);
                    }
                    last_error = Some(error);
                    std::thread::sleep(std::time::Duration::from_millis(15 * (1 << attempt)));
                }
            }
        }
        match last_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    })();
    if wrote_temp && let Some(temp) = &temp_path {
        // Best-effort temp cleanup.
        let _ = std::fs::remove_file(temp);
    }
    result
}

/// TS `resolvePackageRootFromModuleDir(moduleDir)` — walk up (max 8 levels)
/// to the `package.json` whose `name` is `codex-multi-auth`; fallback is
/// `join(moduleDir, "..")`. Exported for tests.
pub fn resolve_package_root_from_module_dir(module_dir: &Path) -> PathBuf {
    let mut current = module_dir.to_path_buf();
    for _depth in 0..8 {
        let package_json_path = current.join("package.json");
        if package_json_path.exists()
            && let Ok(raw) = std::fs::read_to_string(&package_json_path)
            && let Ok(parsed) = serde_json::from_str::<Value>(&raw)
            && parsed.get("name").and_then(Value::as_str) == Some(PACKAGE_NAME)
        {
            return current;
        }
        // Keep walking; malformed metadata should not break startup notices.
        let Some(parent) = current.parent().map(Path::to_path_buf) else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    module_dir.join("..")
}

fn get_module_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn get_package_root() -> PathBuf {
    use std::sync::OnceLock;
    static CACHED_PACKAGE_ROOT: OnceLock<PathBuf> = OnceLock::new();
    CACHED_PACKAGE_ROOT
        .get_or_init(|| resolve_package_root_from_module_dir(&get_module_dir()))
        .clone()
}

/// TS `getCurrentVersion()` — any error ⇒ `"0.0.0"` (debug-logged).
fn get_current_version() -> String {
    let package_json_path = get_package_root().join("package.json");
    let read = std::fs::read_to_string(&package_json_path)
        .map_err(|e| e.to_string())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string()))
        .and_then(|parsed| {
            parsed
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| "missing version".to_string())
        });
    match read {
        Ok(version) => version,
        Err(error) => {
            logger().debug(
                "Failed to read current package version",
                Some(&json!({ "error": error })),
            );
            "0.0.0".to_string()
        }
    }
}

/// TS `loadCache()` — missing/corrupt ⇒ `None` (debug-logged).
fn load_cache() -> Option<LoadedCache> {
    let cache_path = cache_file();
    if !cache_path.exists() {
        return None;
    }
    let parsed: Result<Value, String> = std::fs::read_to_string(&cache_path)
        .map_err(|e| e.to_string())
        .and_then(|content| serde_json::from_str::<Value>(&content).map_err(|e| e.to_string()));
    match parsed {
        Ok(value) => Some(LoadedCache {
            last_check: value.get("lastCheck").and_then(Value::as_f64),
            latest_version: value
                .get("latestVersion")
                .and_then(Value::as_str)
                .map(str::to_string),
            current_version: value
                .get("currentVersion")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        Err(error) => {
            logger().debug("Failed to load update cache", Some(&json!({ "error": error })));
            None
        }
    }
}

/// TS `saveCache(cache)` — queued write; failures logged at `warn` and
/// swallowed.
fn save_cache(cache: &UpdateCheckCache) {
    let _guard = UPDATE_CACHE_WRITE_QUEUE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Err(error) = write_cache_contents(&stringify_pretty2(cache)) {
        logger().warn(
            "Failed to save update cache",
            Some(&json!({ "error": error.to_string() })),
        );
    }
}

struct ParsedSemver {
    core: [i64; 3],
    prerelease: Vec<String>,
}

/// TS `parseSemver(version)`.
fn parse_semver(version: &str) -> ParsedSemver {
    let normalized = version.trim();
    let normalized = normalized
        .strip_prefix('v')
        .or_else(|| normalized.strip_prefix('V'))
        .unwrap_or(normalized);
    let without_build = normalized.split('+').next().unwrap_or("0.0.0");
    // JS `split("-", 2)` TRUNCATES: "1.0.0-beta-2" → ["1.0.0", "beta"] — the
    // prerelease keeps only the segment before the SECOND hyphen.
    let mut dash_parts = without_build.splitn(3, '-');
    let core_part = dash_parts.next().unwrap_or(without_build);
    let prerelease_part = dash_parts.next();
    let core_part = if core_part.is_empty() { "0.0.0" } else { core_part };

    let to_safe_int = |value: &str| -> i64 {
        if !value.chars().all(|c| c.is_ascii_digit()) || value.is_empty() {
            return 0;
        }
        value.parse::<i64>().unwrap_or(0)
    };

    let mut parts = core_part.split('.');
    let major = parts.next().unwrap_or("0");
    let minor = parts.next().unwrap_or("0");
    let patch = parts.next().unwrap_or("0");

    ParsedSemver {
        core: [to_safe_int(major), to_safe_int(minor), to_safe_int(patch)],
        prerelease: match prerelease_part {
            Some(p) if !p.trim().is_empty() => p
                .split('.')
                .filter(|segment| !segment.is_empty())
                .map(str::to_string)
                .collect(),
            _ => Vec::new(),
        },
    }
}

/// Approximation of `latestPart.localeCompare(currentPart, "en",
/// {sensitivity: "case"})`: case-insensitive primary comparison with a
/// lowercase-first tiebreak (matches en collation for the alnum tags npm
/// actually publishes).
fn locale_compare_en_case(latest: &str, current: &str) -> std::cmp::Ordering {
    let primary = latest.to_lowercase().cmp(&current.to_lowercase());
    if primary != std::cmp::Ordering::Equal {
        return primary;
    }
    for (l, c) in latest.chars().zip(current.chars()) {
        if l == c {
            continue;
        }
        let l_lower = l.is_lowercase();
        let c_lower = c.is_lowercase();
        if l_lower != c_lower {
            // lowercase sorts first in en collation (caseFirst: false)
            return if l_lower {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        return l.cmp(&c);
    }
    latest.len().cmp(&current.len())
}

/// TS `comparePrerelease(current, latest)`.
fn compare_prerelease(current: &[String], latest: &[String]) -> i32 {
    let max_len = current.len().max(latest.len());
    for i in 0..max_len {
        let current_part = current.get(i);
        let latest_part = latest.get(i);
        match (current_part, latest_part) {
            (None, None) => return 0,
            (None, Some(_)) => return 1,
            (Some(_), None) => return -1,
            (Some(c), Some(l)) => {
                if c == l {
                    continue;
                }
                let current_is_numeric = !c.is_empty() && c.chars().all(|ch| ch.is_ascii_digit());
                let latest_is_numeric = !l.is_empty() && l.chars().all(|ch| ch.is_ascii_digit());
                if current_is_numeric && latest_is_numeric {
                    let current_num = c.parse::<i64>().unwrap_or(0);
                    let latest_num = l.parse::<i64>().unwrap_or(0);
                    if latest_num > current_num {
                        return 1;
                    }
                    if latest_num < current_num {
                        return -1;
                    }
                    continue;
                }
                if current_is_numeric && !latest_is_numeric {
                    return 1;
                }
                if !current_is_numeric && latest_is_numeric {
                    return -1;
                }
                match locale_compare_en_case(l, c) {
                    std::cmp::Ordering::Greater => return 1,
                    std::cmp::Ordering::Less => return -1,
                    std::cmp::Ordering::Equal => {}
                }
            }
        }
    }
    0
}

/// TS `compareVersions(current, latest)` — `> 0` iff `latest` is newer.
fn compare_versions(current: &str, latest: &str) -> i32 {
    let parsed_current = parse_semver(current);
    let parsed_latest = parse_semver(latest);

    for i in 0..3 {
        let current_part = parsed_current.core[i];
        let latest_part = parsed_latest.core[i];
        if latest_part > current_part {
            return 1;
        }
        if latest_part < current_part {
            return -1;
        }
    }

    let current_has_prerelease = !parsed_current.prerelease.is_empty();
    let latest_has_prerelease = !parsed_latest.prerelease.is_empty();
    if !current_has_prerelease && latest_has_prerelease {
        return -1;
    }
    if current_has_prerelease && !latest_has_prerelease {
        return 1;
    }
    compare_prerelease(&parsed_current.prerelease, &parsed_latest.prerelease)
}

/// TS `fetchLatestVersion(timeoutMs)` — non-OK / wrong package name / any
/// error ⇒ `None` (debug-logged).
async fn fetch_latest_version(timeout_ms: u64) -> Option<String> {
    let result: Result<Option<String>, String> = async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .build()
            .map_err(|e| e.to_string())?;
        let response = client
            .get(NPM_REGISTRY_URL)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            logger().debug(
                "Failed to fetch npm registry",
                Some(&json!({ "status": response.status().as_u16() })),
            );
            return Ok(None);
        }
        let data: Value = response.json().await.map_err(|e| e.to_string())?;
        if data.get("name").and_then(Value::as_str) == Some(PACKAGE_NAME) {
            Ok(data
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_string))
        } else {
            Ok(None)
        }
    }
    .await;
    match result {
        Ok(version) => version,
        Err(error) => {
            logger().debug(
                "Failed to check for updates",
                Some(&json!({ "error": error })),
            );
            None
        }
    }
}

fn build_manual_update_command() -> String {
    format!("npm install -g {PACKAGE_NAME}@latest")
}

/// TS `formatManualUpdateNotice(result)` — FROZEN user-visible string.
pub fn format_manual_update_notice(result: &UpdateCheckResult) -> String {
    // TS interpolates `v${result.latestVersion}` — a null renders as "null".
    let latest = result.latest_version.as_deref().unwrap_or("null");
    [
        format!("codex-multi-auth update available: v{latest}"),
        format!("current: v{}", result.current_version),
        format!("run: {}", result.update_command),
    ]
    .join("; ")
}

/// Core of `checkForUpdates` with the network fetch injected (Rust-only test
/// seam; the TS tests stubbed global `fetch`).
async fn check_for_updates_with<F, Fut>(
    force: bool,
    current_version: String,
    now: i64,
    fetcher: F,
) -> UpdateCheckResult
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Option<String>>,
{
    let cache = load_cache();
    let update_command = build_manual_update_command();

    if !force
        && let Some(cache) = &cache
        && cache.current_version.as_deref() == Some(current_version.as_str())
        && let Some(last_check) = cache.last_check
        && ((now as f64) - last_check) < CHECK_INTERVAL_MS as f64
    {
        let has_update = match &cache.latest_version {
            Some(latest) => compare_versions(&current_version, latest) > 0,
            None => false,
        };
        return UpdateCheckResult {
            has_update,
            current_version,
            latest_version: cache.latest_version.clone(),
            update_command,
        };
    }

    let latest_version = fetcher().await;
    // Cache even a failed fetch (latestVersion: null) for 24h.
    save_cache(&UpdateCheckCache {
        last_check: now,
        latest_version: latest_version.clone(),
        current_version: current_version.clone(),
    });

    let has_update = match &latest_version {
        Some(latest) => compare_versions(&current_version, latest) > 0,
        None => false,
    };

    UpdateCheckResult {
        has_update,
        current_version,
        latest_version,
        update_command,
    }
}

/// TS `checkForUpdates(force = false, fetchTimeoutMs = 5000)`.
pub async fn check_for_updates(force: bool, fetch_timeout_ms: Option<u64>) -> UpdateCheckResult {
    let timeout_ms = fetch_timeout_ms.unwrap_or(UPDATE_CHECK_TIMEOUT_MS);
    check_for_updates_with(force, get_current_version(), now_ms(), || {
        fetch_latest_version(timeout_ms)
    })
    .await
}

/// Toast sink for [`check_and_notify`] (TS `showToast(message, variant)`;
/// variant is `"info" | "warning"`).
pub type ShowToastFn<'a> = &'a (dyn Fn(&str, &str) + Send + Sync);

/// TS `checkAndNotify(showToast?)` — logs the manual notice at `info` and
/// (when provided) shows a toast; all failures swallowed at `debug`.
pub async fn check_and_notify(show_toast: Option<ShowToastFn<'_>>) {
    let result = check_for_updates(false, None).await;
    if result.has_update && result.latest_version.is_some() {
        let message = format_manual_update_notice(&result);
        logger().info(&message, None);
        if let Some(show_toast) = show_toast {
            let latest = result.latest_version.as_deref().unwrap_or("null");
            show_toast(
                &format!(
                    "Plugin update available: v{latest}. Run: {}",
                    result.update_command
                ),
                "info",
            );
        }
    }
}

/// TS `clearUpdateCache()` — queued overwrite with the literal `{}` (only
/// when the file exists); all errors swallowed.
pub fn clear_update_cache() {
    let _guard = UPDATE_CACHE_WRITE_QUEUE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if cache_file().exists() {
        let _ = write_cache_contents("{}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::goldens::read_golden_string;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    // Ported from test/update-notice.test.ts (the fs/fetch mock harness maps
    // onto the env sandbox + the injected fetcher seam).

    async fn run_check(
        force: bool,
        current: &str,
        now: i64,
        fetch_result: Option<&str>,
    ) -> (UpdateCheckResult, bool) {
        let fetched = std::cell::Cell::new(false);
        let result = check_for_updates_with(force, current.to_string(), now, || {
            fetched.set(true);
            let value = fetch_result.map(str::to_string);
            async move { value }
        })
        .await;
        (result, fetched.get())
    }

    #[tokio::test]
    #[serial(env)]
    async fn reports_newer_registry_versions_and_the_manual_install_command() {
        let _sandbox = EnvSandbox::new();
        let now = 1_769_774_400_000; // 2026-01-30T12:00:00Z
        let (result, fetched) = run_check(true, "4.12.0", now, Some("5.0.0")).await;
        assert!(fetched);
        assert!(result.has_update);
        assert_eq!(result.current_version, "4.12.0");
        assert_eq!(result.latest_version.as_deref(), Some("5.0.0"));
        assert_eq!(
            result.update_command,
            "npm install -g codex-multi-auth@latest"
        );
        assert_eq!(
            format_manual_update_notice(&result),
            "codex-multi-auth update available: v5.0.0; current: v4.12.0; run: npm install -g codex-multi-auth@latest"
        );
    }

    #[tokio::test]
    #[serial(env)]
    async fn handles_semver_comparison_table() {
        let _sandbox = EnvSandbox::new();
        let now = 1_769_774_400_000;
        // (latest, has_update, current)
        let cases: &[(&str, bool, &str)] = &[
            ("4.11.0", false, "4.12.0"),
            ("4.12.0", false, "4.12.0"),
            ("v4.13.0", true, "4.12.0"),
            ("0.1.0", true, "0.1.0-beta.0"),
            ("0.1.0-beta.1", false, "0.1.0"),
        ];
        for (latest, has_update, current) in cases {
            let (result, _) = run_check(true, current, now, Some(latest)).await;
            assert_eq!(
                result.has_update, *has_update,
                "latest={latest} current={current}"
            );
        }
    }

    #[test]
    fn compare_versions_covers_prerelease_ordering_rules() {
        // release beats prerelease
        assert!(compare_versions("1.0.0-alpha", "1.0.0") > 0);
        assert!(compare_versions("1.0.0", "1.0.0-alpha") < 0);
        // numeric vs numeric
        assert!(compare_versions("1.0.0-beta.1", "1.0.0-beta.2") > 0);
        // numeric < alphanumeric
        assert!(compare_versions("1.0.0-1", "1.0.0-alpha") > 0);
        assert!(compare_versions("1.0.0-alpha", "1.0.0-1") < 0);
        // missing segment loses (shorter list is older)
        assert!(compare_versions("1.0.0-beta", "1.0.0-beta.1") > 0);
        assert!(compare_versions("1.0.0-beta.1", "1.0.0-beta") < 0);
        // lexical fallback
        assert!(compare_versions("1.0.0-alpha", "1.0.0-beta") > 0);
        // build metadata ignored
        assert_eq!(compare_versions("1.0.0+build.1", "1.0.0+build.2"), 0);
        // equal
        assert_eq!(compare_versions("1.2.3", "1.2.3"), 0);
        // JS split("-", 2) truncation: everything after the second hyphen is
        // dropped, so "1.0.0-beta-2" parses identically to "1.0.0-beta".
        assert_eq!(compare_versions("1.0.0-beta-2", "1.0.0-beta"), 0);
        assert_eq!(compare_versions("1.0.0-beta", "1.0.0-beta-9"), 0);
    }

    #[tokio::test]
    #[serial(env)]
    async fn reuses_the_daily_cache_without_another_registry_fetch() {
        let _sandbox = EnvSandbox::new();
        let now = 1_769_774_400_000_i64;
        save_cache(&UpdateCheckCache {
            last_check: now - 1_000,
            latest_version: Some("5.0.0".to_string()),
            current_version: "4.12.0".to_string(),
        });

        let (result, fetched) = run_check(false, "4.12.0", now, Some("9.9.9")).await;
        assert!(!fetched, "cache hit must not fetch");
        assert!(result.has_update);
        assert_eq!(result.latest_version.as_deref(), Some("5.0.0"));
    }

    #[tokio::test]
    #[serial(env)]
    async fn refreshes_the_daily_cache_when_the_installed_version_changes() {
        let _sandbox = EnvSandbox::new();
        let now = 1_769_774_400_000_i64;
        save_cache(&UpdateCheckCache {
            last_check: now - 1_000,
            latest_version: Some("4.13.0".to_string()),
            current_version: "4.11.0".to_string(),
        });

        let (result, fetched) = run_check(false, "4.12.0", now, Some("5.0.0")).await;
        assert!(fetched, "version change must refetch");
        assert_eq!(result.latest_version.as_deref(), Some("5.0.0"));
        assert!(result.has_update);
    }

    #[tokio::test]
    #[serial(env)]
    async fn refreshes_stale_cache_entries_and_writes_the_new_result() {
        let _sandbox = EnvSandbox::new();
        let now = 1_769_774_400_000_i64;
        save_cache(&UpdateCheckCache {
            last_check: now - 25 * 60 * 60 * 1_000,
            latest_version: Some("4.13.0".to_string()),
            current_version: "4.12.0".to_string(),
        });

        let (result, fetched) = run_check(false, "4.12.0", now, Some("5.0.0")).await;
        assert!(fetched);
        assert_eq!(result.latest_version.as_deref(), Some("5.0.0"));
        let written = std::fs::read_to_string(cache_file()).unwrap();
        assert!(written.contains("\"latestVersion\": \"5.0.0\""));
    }

    #[tokio::test]
    #[serial(env)]
    async fn caches_failed_fetches_as_null_for_24_hours() {
        let _sandbox = EnvSandbox::new();
        let now = 1_769_774_400_000_i64;
        let (result, _) = run_check(true, "4.12.0", now, None).await;
        assert!(!result.has_update);
        assert_eq!(result.latest_version, None);

        let written = std::fs::read_to_string(cache_file()).unwrap();
        assert!(written.contains("\"latestVersion\": null"));

        // The cached failure short-circuits the next non-forced check.
        let (cached, fetched) = run_check(false, "4.12.0", now + 1_000, Some("9.9.9")).await;
        assert!(!fetched);
        assert_eq!(cached.latest_version, None);
        assert!(!cached.has_update);
    }

    #[tokio::test]
    #[serial(env)]
    async fn cache_serialization_matches_the_ts_golden_bytes() {
        let _sandbox = EnvSandbox::new();
        save_cache(&UpdateCheckCache {
            last_check: 1_750_000_000_000,
            latest_version: Some("9.9.9".to_string()),
            current_version: "2.7.1".to_string(),
        });
        let written = std::fs::read(cache_file()).unwrap();
        let golden = read_golden_string("update-check-cache.json");
        assert_eq!(String::from_utf8(written).unwrap(), golden);
        assert!(!golden.ends_with('\n'), "cache must have NO trailing newline");
    }

    #[tokio::test]
    #[serial(env)]
    async fn clears_the_cached_notice_file_to_a_literal_empty_object() {
        let _sandbox = EnvSandbox::new();
        // No-op when the file does not exist.
        clear_update_cache();
        assert!(!cache_file().exists());

        save_cache(&UpdateCheckCache {
            last_check: 1,
            latest_version: Some("5.0.0".to_string()),
            current_version: "4.12.0".to_string(),
        });
        clear_update_cache();
        let written = std::fs::read_to_string(cache_file()).unwrap();
        assert_eq!(written, "{}");

        // A cleared cache is treated as stale (fields all absent).
        let now = 1_769_774_400_000_i64;
        let (_, fetched) = run_check(false, "4.12.0", now, Some("5.0.0")).await;
        assert!(fetched, "cleared cache must force a refetch");
    }

    #[test]
    #[serial(env)]
    fn resolves_the_package_root_by_walking_up_to_package_metadata() {
        let sandbox = EnvSandbox::new();
        let package_root = sandbox.root().join("node_modules").join("codex-multi-auth");
        let module_dir = package_root.join("dist").join("lib");
        std::fs::create_dir_all(&module_dir).unwrap();
        std::fs::write(
            package_root.join("package.json"),
            "{\"name\": \"codex-multi-auth\", \"version\": \"4.12.0\"}",
        )
        .unwrap();

        assert_eq!(
            resolve_package_root_from_module_dir(&module_dir),
            package_root
        );

        // Wrong-name package.json keeps walking; no match falls back to "..".
        let other_dir = sandbox.root().join("other").join("dist");
        std::fs::create_dir_all(&other_dir).unwrap();
        std::fs::write(
            sandbox.root().join("other").join("package.json"),
            "{\"name\": \"other-package\", \"version\": \"1.0.0\"}",
        )
        .unwrap();
        assert_eq!(
            resolve_package_root_from_module_dir(&other_dir),
            other_dir.join("..")
        );
    }

    #[test]
    fn format_manual_update_notice_is_the_frozen_string() {
        let result = UpdateCheckResult {
            has_update: true,
            current_version: "4.12.0".to_string(),
            latest_version: Some("5.0.0".to_string()),
            update_command: build_manual_update_command(),
        };
        assert_eq!(
            format_manual_update_notice(&result),
            "codex-multi-auth update available: v5.0.0; current: v4.12.0; run: npm install -g codex-multi-auth@latest"
        );
    }
}
