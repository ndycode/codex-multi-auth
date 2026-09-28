//! Wrapper startup update notice — port of the update-notice half of
//! `scripts/codex.js` + the cache/semver logic of `lib/update-notice.ts`.
//!
//! Contract (spec 14 §6): best-effort DAILY npm check; the printed update
//! command is ONLY `npm install -g codex-multi-auth@latest`; TTY-only unless
//! `CODEX_MULTI_AUTH_DEBUG=1`; never runs npm itself. Startup is budgeted
//! (default 3000 ms; fetch timeout = 80% of the budget).
//!
//! The wrapper crate has no HTTP client dependency, so the npm-registry fetch
//! is an injectable seam ([`LatestVersionFetch`]); without a fetcher the check
//! is cache-only (fresh cache still yields notices; a stale cache skips
//! silently — the manager binary refreshes the shared cache on its own runs).

use std::fs;
use std::future::Future;
use std::io::IsTerminal;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::Duration;

use crate::routing::{is_pure_help_or_version_args, should_handle_multi_auth_auth};

/// TS `CHECK_INTERVAL_MS` (lib/update-notice.ts) — 24 h.
pub const CHECK_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;
/// TS `UPDATE_CHECK_TIMEOUT_MS`.
pub const UPDATE_CHECK_TIMEOUT_MS: u64 = 5_000;
/// TS `DEFAULT_STARTUP_UPDATE_NOTICE_BUDGET_MS` (scripts/codex.js).
pub const DEFAULT_STARTUP_UPDATE_NOTICE_BUDGET_MS: u64 = 3_000;
const PACKAGE_NAME: &str = "codex-multi-auth";

/// TS `UpdateCheckResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateCheckResult {
    pub has_update: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_command: String,
}

/// The injectable npm-registry lookup (`fetchLatestVersion` seam). The
/// cma-bin main wires this to the manager's reqwest-backed fetcher.
pub trait LatestVersionFetch: Send + Sync {
    fn fetch_latest_version(
        &self,
        timeout_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>;
}

/// TS `buildManualUpdateCommand()` — the ONLY update command ever printed.
pub fn build_manual_update_command() -> String {
    format!("npm install -g {PACKAGE_NAME}@latest")
}

/// TS `formatManualUpdateNotice(result)`.
pub fn format_manual_update_notice(result: &UpdateCheckResult) -> String {
    [
        format!(
            "codex-multi-auth update available: v{}",
            result.latest_version.as_deref().unwrap_or("")
        ),
        format!("current: v{}", result.current_version),
        format!("run: {}", result.update_command),
    ]
    .join("; ")
}

/// TS `getCurrentVersion()` — env `CODEX_MULTI_AUTH_CLI_VERSION` (hydrated by
/// the launcher) then the crate version; `0.0.0` fallback.
pub fn get_current_version() -> String {
    let from_env = std::env::var("CODEX_MULTI_AUTH_CLI_VERSION").unwrap_or_default();
    let from_env = from_env.trim();
    if !from_env.is_empty() {
        return from_env.to_string();
    }
    let built_in = env!("CARGO_PKG_VERSION").trim();
    if built_in.is_empty() {
        "0.0.0".to_string()
    } else {
        built_in.to_string()
    }
}

// ---------------------------------------------------------------------------
// Semver comparison (hand-rolled — lib/update-notice.ts parity).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedSemver {
    core: [u64; 3],
    prerelease: Vec<String>,
}

fn to_safe_int(value: &str) -> u64 {
    if !value.is_empty() && value.chars().all(|c| c.is_ascii_digit()) {
        value.parse().unwrap_or(0)
    } else {
        0
    }
}

fn parse_semver(version: &str) -> ParsedSemver {
    let normalized = version.trim();
    let normalized = normalized
        .strip_prefix('v')
        .or_else(|| normalized.strip_prefix('V'))
        .unwrap_or(normalized);
    let without_build = normalized.split('+').next().unwrap_or("0.0.0");
    let mut split = without_build.splitn(2, '-');
    let core_part = split.next().unwrap_or("0.0.0");
    let prerelease_part = split.next();
    let mut core_iter = core_part.split('.');
    let core = [
        to_safe_int(core_iter.next().unwrap_or("0")),
        to_safe_int(core_iter.next().unwrap_or("0")),
        to_safe_int(core_iter.next().unwrap_or("0")),
    ];
    let prerelease = prerelease_part
        .map(|p| {
            p.split('.')
                .filter(|segment| !segment.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    ParsedSemver { core, prerelease }
}

fn compare_prerelease(current: &[String], latest: &[String]) -> i32 {
    let max_len = current.len().max(latest.len());
    for i in 0..max_len {
        let current_part = current.get(i);
        let latest_part = latest.get(i);
        match (current_part, latest_part) {
            (None, None) => return 0,
            // current ran out → latest is "greater" (newer)
            (None, Some(_)) => return 1,
            (Some(_), None) => return -1,
            (Some(c), Some(l)) => {
                if c == l {
                    continue;
                }
                let c_num = c.chars().all(|ch| ch.is_ascii_digit());
                let l_num = l.chars().all(|ch| ch.is_ascii_digit());
                if c_num && l_num {
                    let cn: u64 = c.parse().unwrap_or(0);
                    let ln: u64 = l.parse().unwrap_or(0);
                    if ln > cn {
                        return 1;
                    }
                    if ln < cn {
                        return -1;
                    }
                    continue;
                }
                if c_num && !l_num {
                    return 1;
                }
                if !c_num && l_num {
                    return -1;
                }
                match l.cmp(c) {
                    std::cmp::Ordering::Greater => return 1,
                    std::cmp::Ordering::Less => return -1,
                    std::cmp::Ordering::Equal => continue,
                }
            }
        }
    }
    0
}

/// TS `compareVersions(current, latest)` — returns 1 when `latest` is newer
/// than `current`, -1 when older, 0 when equal.
pub fn compare_versions(current: &str, latest: &str) -> i32 {
    let parsed_current = parse_semver(current);
    let parsed_latest = parse_semver(latest);
    for i in 0..3 {
        let c = parsed_current.core[i];
        let l = parsed_latest.core[i];
        if l > c {
            return 1;
        }
        if l < c {
            return -1;
        }
    }
    let current_has = !parsed_current.prerelease.is_empty();
    let latest_has = !parsed_latest.prerelease.is_empty();
    if !current_has && latest_has {
        return -1;
    }
    if current_has && !latest_has {
        return 1;
    }
    compare_prerelease(&parsed_current.prerelease, &parsed_latest.prerelease)
}

// ---------------------------------------------------------------------------
// Cache (`<cache dir>/update-check-cache.json` — shared with the manager).
// ---------------------------------------------------------------------------

fn cache_file_path() -> PathBuf {
    cma_core::runtime_paths::get_codex_cache_dir().join("update-check-cache.json")
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckCache {
    last_check: i64,
    latest_version: Option<String>,
    current_version: String,
}

fn load_cache() -> Option<UpdateCheckCache> {
    let path = cache_file_path();
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// TS `saveCache` — `JSON.stringify(cache, null, 2)` (NO trailing newline),
/// temp+rename, EBUSY/EPERM/ENOTEMPTY ×4 with 15·2^n backoff. Best-effort.
fn save_cache(cache: &UpdateCheckCache) {
    let path = cache_file_path();
    let Some(dir) = path.parent() else {
        return;
    };
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let serialized = cma_core::json_io::stringify_pretty2(
        &serde_json::to_value(cache).unwrap_or(serde_json::Value::Null),
    );
    let temp = cma_core::temp_path::temp_path_for(&path);
    for attempt in 0..4u32 {
        let result = fs::write(&temp, serialized.as_bytes()).and_then(|()| fs::rename(&temp, &path));
        match result {
            Ok(()) => return,
            Err(error) => {
                let retryable = matches!(
                    cma_core::fs_retry::code_of(&error),
                    Some("EBUSY") | Some("EPERM") | Some("ENOTEMPTY")
                );
                if !retryable || attempt >= 3 {
                    let _ = fs::remove_file(&temp);
                    return;
                }
                std::thread::sleep(Duration::from_millis(15 * 2u64.pow(attempt)));
            }
        }
    }
}

/// TS `checkForUpdates(force, fetchTimeoutMs)` — daily-cached npm lookup.
/// Without a fetcher, a stale cache resolves to "no update known" (latest =
/// cached value if fresh, else `None`) and the cache is left untouched.
pub async fn check_for_updates(
    force: bool,
    fetch_timeout_ms: u64,
    fetcher: Option<&dyn LatestVersionFetch>,
) -> UpdateCheckResult {
    let current_version = get_current_version();
    let cache = load_cache();
    let now = cma_core::utils::now_ms();
    let update_command = build_manual_update_command();

    if !force
        && let Some(cache) = &cache
        && cache.current_version == current_version
        && now - cache.last_check < CHECK_INTERVAL_MS
    {
        let has_update = cache
            .latest_version
            .as_deref()
            .is_some_and(|latest| compare_versions(&current_version, latest) > 0);
        return UpdateCheckResult {
            has_update,
            current_version,
            latest_version: cache.latest_version.clone(),
            update_command,
        };
    }

    let Some(fetcher) = fetcher else {
        // No network seam: skip quietly (cache stays as-is for the manager).
        return UpdateCheckResult {
            has_update: false,
            current_version,
            latest_version: None,
            update_command,
        };
    };

    let latest_version = fetcher.fetch_latest_version(fetch_timeout_ms).await;
    save_cache(&UpdateCheckCache {
        last_check: now,
        latest_version: latest_version.clone(),
        current_version: current_version.clone(),
    });
    let has_update = latest_version
        .as_deref()
        .is_some_and(|latest| compare_versions(&current_version, latest) > 0);
    UpdateCheckResult {
        has_update,
        current_version,
        latest_version,
        update_command,
    }
}

// ---------------------------------------------------------------------------
// Startup gating + budget (scripts/codex.js half).
// ---------------------------------------------------------------------------

fn read_boolean_env_flag(name: &str) -> Option<bool> {
    let normalized = std::env::var(name)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "1" | "true" | "yes" => Some(true),
        "0" | "false" | "no" => Some(false),
        _ => None,
    }
}

fn is_startup_update_notice_debug_enabled() -> bool {
    read_boolean_env_flag("CODEX_MULTI_AUTH_DEBUG") == Some(true)
}

/// TS `shouldLogStartupUpdateNotice()` — stderr TTY or DEBUG.
pub fn should_log_startup_update_notice() -> bool {
    std::io::stderr().is_terminal() || is_startup_update_notice_debug_enabled()
}

/// TS `readStartupUpdateNoticeBudgetMs()`.
pub fn read_startup_update_notice_budget_ms() -> u64 {
    let raw = std::env::var("CODEX_MULTI_AUTH_UPDATE_NOTICE_STARTUP_BUDGET_MS")
        .or_else(|_| std::env::var("CODEX_MULTI_AUTH_TEST_STARTUP_UPDATE_NOTICE_BUDGET_MS"))
        .unwrap_or_default();
    if raw.is_empty() {
        return DEFAULT_STARTUP_UPDATE_NOTICE_BUDGET_MS;
    }
    match raw.trim().parse::<i64>() {
        Ok(parsed) if parsed > 0 => parsed as u64,
        _ => DEFAULT_STARTUP_UPDATE_NOTICE_BUDGET_MS,
    }
}

/// TS `resolveStartupUpdateNoticeTimeoutMs(budgetMs)` — 80% of the budget,
/// min 1 ms.
pub fn resolve_startup_update_notice_timeout_ms(budget_ms: u64) -> u64 {
    ((budget_ms as f64 * 0.8).floor() as u64).max(1)
}

/// TS `shouldRunStartupUpdateNotice(rawArgs, normalizedArgs)` — skipped for
/// BYPASS=1, pure help/version, and locally-handled auth commands.
pub fn should_run_startup_update_notice(raw_args: &[String], normalized_args: &[String]) -> bool {
    if std::env::var("CODEX_MULTI_AUTH_BYPASS")
        .unwrap_or_default()
        .trim()
        == "1"
    {
        return false;
    }
    if is_pure_help_or_version_args(raw_args) {
        return false;
    }
    if should_handle_multi_auth_auth(normalized_args) {
        return false;
    }
    true
}

fn log_startup_update_notice_debug(message: &str) {
    if is_startup_update_notice_debug_enabled() {
        eprintln!("codex-multi-auth: {message}");
    }
}

/// TS `showUpdateNoticeIfAvailable(rawArgs, normalizedArgs)` — budget-raced
/// check + stderr notice. Never fails the launch.
pub async fn show_update_notice_if_available(
    raw_args: &[String],
    normalized_args: &[String],
    fetcher: Option<&dyn LatestVersionFetch>,
) {
    if !should_run_startup_update_notice(raw_args, normalized_args) {
        return;
    }
    let budget_ms = read_startup_update_notice_budget_ms();
    let fetch_timeout_ms = resolve_startup_update_notice_timeout_ms(budget_ms);
    let check = check_for_updates(false, fetch_timeout_ms, fetcher);
    let result = tokio::time::timeout(Duration::from_millis(budget_ms), check).await;
    match result {
        Err(_) => {
            log_startup_update_notice_debug(&format!(
                "update notice skipped: startup budget exceeded after {budget_ms}ms"
            ));
        }
        Ok(result) => {
            if result.has_update
                && result.latest_version.is_some()
                && should_log_startup_update_notice()
            {
                eprintln!("{}", format_manual_update_notice(&result));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_update_command_is_frozen() {
        assert_eq!(
            build_manual_update_command(),
            "npm install -g codex-multi-auth@latest"
        );
    }

    #[test]
    fn notice_format() {
        let result = UpdateCheckResult {
            has_update: true,
            current_version: "6.9.0".to_string(),
            latest_version: Some("6.10.0".to_string()),
            update_command: build_manual_update_command(),
        };
        assert_eq!(
            format_manual_update_notice(&result),
            "codex-multi-auth update available: v6.10.0; current: v6.9.0; run: npm install -g codex-multi-auth@latest"
        );
    }

    #[test]
    fn version_comparison_core() {
        assert_eq!(compare_versions("1.0.0", "1.0.1"), 1);
        assert_eq!(compare_versions("1.2.0", "1.1.9"), -1);
        assert_eq!(compare_versions("2.7.1", "2.7.1"), 0);
        assert_eq!(compare_versions("v2.7.1", "2.7.2"), 1);
        assert_eq!(compare_versions("1.0.0+build5", "1.0.0"), 0);
    }

    #[test]
    fn version_comparison_prerelease() {
        // Release > prerelease of the same core.
        assert_eq!(compare_versions("3.0.0-alpha.0", "3.0.0"), 1);
        assert_eq!(compare_versions("3.0.0", "3.0.0-alpha.0"), -1);
        // Numeric prerelease ordering.
        assert_eq!(compare_versions("1.0.0-alpha.1", "1.0.0-alpha.2"), 1);
        // Numeric < alphanumeric.
        assert_eq!(compare_versions("1.0.0-1", "1.0.0-alpha"), 1);
        assert_eq!(compare_versions("1.0.0-alpha", "1.0.0-1"), -1);
        // Longer prerelease wins over its prefix.
        assert_eq!(compare_versions("1.0.0-alpha", "1.0.0-alpha.1"), 1);
        assert_eq!(compare_versions("1.0.0-alpha.1", "1.0.0-alpha"), -1);
        // Garbage segments parse to 0.
        assert_eq!(compare_versions("x.y.z", "0.0.0"), 0);
    }

    #[test]
    fn budget_and_timeout_resolution() {
        assert_eq!(resolve_startup_update_notice_timeout_ms(3000), 2400);
        assert_eq!(resolve_startup_update_notice_timeout_ms(1), 1);
        assert_eq!(resolve_startup_update_notice_timeout_ms(0), 1);
    }

    #[test]
    fn startup_gating_help_and_auth() {
        let raw: Vec<String> = vec!["--help".to_string()];
        assert!(!should_run_startup_update_notice(&raw, &raw));
        let auth: Vec<String> = vec!["auth".to_string(), "status".to_string()];
        assert!(!should_run_startup_update_notice(&auth, &auth));
        let exec: Vec<String> = vec!["exec".to_string()];
        // May still be suppressed by BYPASS in the ambient env; only assert the
        // positive path when BYPASS is not set.
        if std::env::var("CODEX_MULTI_AUTH_BYPASS").unwrap_or_default().trim() != "1" {
            assert!(should_run_startup_update_notice(&exec, &exec));
        }
    }

    struct FixedFetcher(Option<String>);

    impl LatestVersionFetch for FixedFetcher {
        fn fetch_latest_version(
            &self,
            _timeout_ms: u64,
        ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
            let value = self.0.clone();
            Box::pin(async move { value })
        }
    }

    #[tokio::test]
    #[serial_test::serial(env)]
    async fn check_without_fetcher_and_without_cache_is_silent() {
        let _sandbox = cma_testkit::sandbox::EnvSandbox::new();
        // No cache file in the sandbox → no update.
        let result = check_for_updates(true, 100, None).await;
        assert!(!result.has_update);
        assert_eq!(result.update_command, build_manual_update_command());
    }

    #[tokio::test]
    #[serial_test::serial(env)]
    async fn check_with_fetcher_detects_update_and_caches() {
        let _sandbox = cma_testkit::sandbox::EnvSandbox::new();
        let fetcher = FixedFetcher(Some("999.0.0".to_string()));
        let result = check_for_updates(true, 100, Some(&fetcher)).await;
        assert!(result.has_update);
        assert_eq!(result.latest_version.as_deref(), Some("999.0.0"));
        // Cache written with the exact TS shape (2-space indent, no newline).
        let raw = fs::read_to_string(cache_file_path()).unwrap();
        assert!(raw.starts_with("{\n  \"lastCheck\":"));
        assert!(!raw.ends_with('\n'));
        assert!(raw.contains("\"latestVersion\": \"999.0.0\""));
        // Second (non-forced) check hits the fresh cache without a fetcher.
        let cached = check_for_updates(false, 100, None).await;
        assert!(cached.has_update);
        assert_eq!(cached.latest_version.as_deref(), Some("999.0.0"));
    }
}
