//! Port of `lib/runtime/first-run.ts` — lazy first-run setup (audit roadmap
//! §4.5.4) replacing the old npm postinstall: detects the packaged Codex
//! desktop app, auto-binds runtime rotation, installs launcher shortcuts.
//!
//! Once per runtime root, guarded by an exclusive-create marker file
//! (`first-run-setup.json`, **TAB-indented** JSON + trailing `\n`, mode 0o600,
//! O_EXCL claim so concurrent first invocations run at most once). Every step
//! is best-effort: failures are debug-logged (messages only — never tokens or
//! emails) and the command proceeds normally; `ensure_first_run_setup` never
//! fails the caller.
//!
//! CI-detection quirk (spec 10 gotcha 13): any non-empty CI var that is not an
//! explicit false token counts as CI (`CI=banana` ⇒ CI; `CI=0` ⇒ not CI).
//! Rotation-enabled defaults TRUE on config error (gotcha 14).

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use serde::Serialize;

use cma_config::getters::get_codex_runtime_rotation_proxy;
use cma_config::load::load_plugin_config;
use cma_core::json_io::{
    stringify_pretty_tab, write_json_atomic_sync, TrailingNewline, WriteJsonOptions,
};
use cma_core::logger::create_logger;
use cma_core::runtime_paths::get_codex_multi_auth_dir;
use cma_core::utils::now_ms;

use crate::app_bind::{bind_codex_app_runtime_rotation, get_app_bind_status, AppBindOptions};
use crate::app_launcher::{install_codex_app_launcher, AppLauncherOptions};

pub const FIRST_RUN_MARKER_FILE: &str = "first-run-setup.json";
pub const FIRST_RUN_MARKER_VERSION: i64 = 1;

const TRUE_VALUES: &[&str] = &["1", "true", "yes"];
const FALSE_VALUES: &[&str] = &["0", "false", "no"];
const CI_ENV_KEYS: &[&str] = &[
    "CI",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "CIRCLECI",
    "BUILDKITE",
    "TF_BUILD",
    "TEAMCITY_VERSION",
    "JENKINS_URL",
    "TRAVIS",
    "APPVEYOR",
    "BITBUCKET_BUILD_NUMBER",
];

/// Environment override map for tests (`None` entries are simply absent).
pub type EnvMap = HashMap<String, String>;

fn env_get(env: Option<&EnvMap>, key: &str) -> Option<String> {
    match env {
        Some(map) => map.get(key).cloned(),
        None => std::env::var(key).ok(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstRunStepStatus {
    Completed,
    Skipped,
    Failed,
}

impl FirstRunStepStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            FirstRunStepStatus::Completed => "completed",
            FirstRunStepStatus::Skipped => "skipped",
            FirstRunStepStatus::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstRunSkipReason {
    Ci,
    NotInstalled,
    AlreadyDone,
    ClaimRace,
    Error,
}

impl FirstRunSkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            FirstRunSkipReason::Ci => "ci",
            FirstRunSkipReason::NotInstalled => "not-installed",
            FirstRunSkipReason::AlreadyDone => "already-done",
            FirstRunSkipReason::ClaimRace => "claim-race",
            FirstRunSkipReason::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstRunResult {
    Ran {
        app_bind: FirstRunStepStatus,
        launcher: FirstRunStepStatus,
    },
    Skipped(FirstRunSkipReason),
}

/// A setup step: resolves to a status, or an error message (mapped to
/// `"failed"` + debug log by the runner — the TS `catch` branch).
pub type FirstRunStep = Box<
    dyn FnOnce() -> Pin<Box<dyn Future<Output = Result<FirstRunStepStatus, String>> + Send>>
        + Send,
>;

/// Test-injectable dependencies (TS `FirstRunSetupDeps`).
#[derive(Default)]
pub struct FirstRunSetupDeps {
    pub env: Option<EnvMap>,
    pub marker_path: Option<PathBuf>,
    pub installed_context: Option<bool>,
    pub detect_desktop_app: Option<Box<dyn Fn() -> bool + Send + Sync>>,
    pub resolve_rotation: Option<Box<dyn Fn() -> bool + Send + Sync>>,
    pub bind_codex_app: Option<FirstRunStep>,
    pub install_launcher: Option<FirstRunStep>,
    pub notify: Option<crate::app_launcher::SharedLogSink>,
    pub now: Option<crate::app_bind::NowFn>,
}

/// `readOptionalBoolean` — tri-state: TRUE_VALUES → true, FALSE_VALUES →
/// false, unset/blank/unknown → None.
fn read_optional_boolean(value: Option<&str>) -> Option<bool> {
    let value = value?;
    if value.trim().is_empty() {
        return None;
    }
    let normalized = value.trim().to_lowercase();
    if TRUE_VALUES.contains(&normalized.as_str()) {
        return Some(true);
    }
    if FALSE_VALUES.contains(&normalized.as_str()) {
        return Some(false);
    }
    None
}

/// Set + non-blank + not an explicit false token ⇒ enabled (`CI=banana` is
/// enabled; `CI=0` is not).
fn is_enabled_env_flag(env: Option<&EnvMap>, key: &str) -> bool {
    let Some(value) = env_get(env, key) else {
        return false;
    };
    if value.trim().is_empty() {
        return false;
    }
    read_optional_boolean(Some(&value)) != Some(false)
}

pub fn is_ci_environment(env: Option<&EnvMap>) -> bool {
    if read_optional_boolean(env_get(env, "npm_config_ignore_scripts").as_deref()) == Some(true) {
        return true;
    }
    CI_ENV_KEYS.iter().any(|key| is_enabled_env_flag(env, key))
}

fn directory_contains_entry_with_prefix(directory: &Path, prefix: &str) -> bool {
    match std::fs::read_dir(directory) {
        Ok(entries) => entries.flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(prefix)
        }),
        Err(_) => false,
    }
}

/// `hasCodexDesktopApp` — win32: `OpenAI.Codex_*` under
/// `%LOCALAPPDATA%\Packages` (fallback `home/AppData/Local`) or
/// `%ProgramFiles%|%ProgramW6432%\WindowsApps` (fallback
/// `C:\Program Files`); darwin: `Codex.app` under `/Applications` or
/// `~/Applications`; other platforms: false. Directory read failures → false.
pub fn has_codex_desktop_app(
    env: Option<&EnvMap>,
    platform: Option<&str>,
    home: Option<&Path>,
) -> bool {
    let platform = platform.unwrap_or(crate::app_bind::current_platform());
    let default_home;
    let home = match home {
        Some(home) => home,
        None => {
            default_home = env_get(env, "USERPROFILE")
                .or_else(|| env_get(env, "HOME"))
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            &default_home
        }
    };

    if platform == "win32" {
        let local_app_data = env_get(env, "LOCALAPPDATA")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        let program_files = env_get(env, "ProgramFiles")
            .or_else(|| env_get(env, "ProgramW6432"))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Program Files"));
        return directory_contains_entry_with_prefix(
            &local_app_data.join("Packages"),
            "OpenAI.Codex_",
        ) || directory_contains_entry_with_prefix(
            &program_files.join("WindowsApps"),
            "OpenAI.Codex_",
        );
    }

    if platform == "darwin" {
        return Path::new("/Applications/Codex.app").exists()
            || home.join("Applications").join("Codex.app").exists();
    }

    false
}

/// `resolveRotationEnabled` — env override
/// `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY` wins; else the config reader;
/// reader errors default to **true** (rotation defaults on; a malformed
/// config must not block first-run setup).
pub fn resolve_rotation_enabled(
    env: Option<&EnvMap>,
    read_config_rotation: impl Fn() -> Result<bool, String>,
) -> bool {
    if let Some(env_override) = read_optional_boolean(
        env_get(env, "CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY").as_deref(),
    ) {
        return env_override;
    }
    read_config_rotation().unwrap_or(true)
}

fn default_read_config_rotation() -> Result<bool, String> {
    Ok(get_codex_runtime_rotation_proxy(&load_plugin_config()))
}

/// `shouldBindCodexAppOnFirstRun` — CI always wins; then
/// `CODEX_MULTI_AUTH_APP_BIND` (tri-state), then
/// `CODEX_MULTI_AUTH_APP_BIND_INSTALL` (tri-state), then
/// `rotation_enabled && app_detected`.
pub fn should_bind_codex_app_on_first_run(
    env: Option<&EnvMap>,
    rotation_enabled: bool,
    app_detected: bool,
) -> bool {
    if is_ci_environment(env) {
        return false;
    }
    if let Some(bind_override) =
        read_optional_boolean(env_get(env, "CODEX_MULTI_AUTH_APP_BIND").as_deref())
    {
        return bind_override;
    }
    if let Some(install_override) =
        read_optional_boolean(env_get(env, "CODEX_MULTI_AUTH_APP_BIND_INSTALL").as_deref())
    {
        return install_override;
    }
    if !rotation_enabled {
        return false;
    }
    app_detected
}

/// `shouldInstallCodexAppLauncherOnFirstRun` — CI wins; then
/// `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL` (tri-state), then
/// `rotation_enabled`.
pub fn should_install_codex_app_launcher_on_first_run(
    env: Option<&EnvMap>,
    rotation_enabled: bool,
) -> bool {
    if is_ci_environment(env) {
        return false;
    }
    if let Some(install_override) =
        read_optional_boolean(env_get(env, "CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL").as_deref())
    {
        return install_override;
    }
    rotation_enabled
}

/// First-run setup only fires for a durable, machine-level install.
///
/// The TS gate keyed off the module path (`node_modules` + not `_npx` + not
/// project-local). The Rust binary has no `node_modules` analogue, so the
/// port's explicit equivalent semantics (spec 10 §3 port note) are:
///
/// - NOT an npx cache run (`_npx` path segment) — someone trying the tool once
///   must not burn the once-only marker;
/// - NOT a cargo dev build (a `target/debug` or `target/release` segment pair
///   — repo checkouts and test runs stay side-effect-free);
/// - NOT inside the invoking working directory (a project-local binary is not
///   a machine-level install).
pub fn is_installed_package_context(exe_path: Option<&Path>, cwd: Option<&Path>) -> bool {
    let resolved_exe;
    let exe_path = match exe_path {
        Some(path) => path,
        None => match std::env::current_exe() {
            Ok(path) => {
                resolved_exe = path;
                &resolved_exe
            }
            Err(_) => return false,
        },
    };
    let resolved_cwd;
    let cwd = match cwd {
        Some(path) => path,
        None => match std::env::current_dir() {
            Ok(path) => {
                resolved_cwd = path;
                &resolved_cwd
            }
            Err(_) => return false,
        },
    };

    let segments: Vec<String> = exe_path
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    if segments.iter().any(|segment| segment == "_npx") {
        return false;
    }
    let is_cargo_build_dir = segments.windows(2).any(|pair| {
        pair[0] == "target" && (pair[1] == "debug" || pair[1] == "release")
    });
    if is_cargo_build_dir {
        return false;
    }
    if exe_path.starts_with(cwd) {
        return false;
    }
    true
}

fn get_first_run_marker_path() -> PathBuf {
    get_codex_multi_auth_dir().join(FIRST_RUN_MARKER_FILE)
}

#[derive(Serialize)]
struct ClaimMarker {
    version: i64,
    #[serde(rename = "startedAt")]
    started_at: i64,
}

#[derive(Serialize)]
struct FinalMarker {
    version: i64,
    #[serde(rename = "startedAt")]
    started_at: i64,
    #[serde(rename = "completedAt")]
    completed_at: i64,
    #[serde(rename = "appBind")]
    app_bind: &'static str,
    launcher: &'static str,
}

/// Claims the marker with an exclusive create (O_EXCL, mode 0o600, payload
/// `{"version":1,"startedAt":N}` TAB-indented + `\n`) so at most one process
/// runs the setup. `Ok(false)` when another process already holds (or
/// completed) the claim.
fn claim_first_run_marker(marker_path: &Path, started_at: i64) -> io::Result<bool> {
    if let Some(parent) = marker_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let payload = format!(
        "{}\n",
        stringify_pretty_tab(&ClaimMarker {
            version: FIRST_RUN_MARKER_VERSION,
            started_at,
        })
    );
    let mut open_options = std::fs::OpenOptions::new();
    open_options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open_options.mode(0o600);
    }
    match open_options.open(marker_path) {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(payload.as_bytes())?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error),
    }
}

/// Finalize the marker atomically. Failures are only debug-logged — the claim
/// file already guarantees once-only behavior.
fn finalize_first_run_marker(
    marker_path: &Path,
    started_at: i64,
    app_bind: FirstRunStepStatus,
    launcher: FirstRunStepStatus,
    now: i64,
) {
    let payload = stringify_pretty_tab(&FinalMarker {
        version: FIRST_RUN_MARKER_VERSION,
        started_at,
        completed_at: now,
        app_bind: app_bind.as_str(),
        launcher: launcher.as_str(),
    });
    let result = write_json_atomic_sync(
        marker_path,
        &payload,
        Some(0o600),
        &WriteJsonOptions {
            trailing_newline: TrailingNewline::Lf,
            ..WriteJsonOptions::default()
        },
    );
    if let Err(error) = result {
        create_logger("first-run").debug(
            "first-run marker finalize failed",
            Some(&serde_json::json!({ "error": error.to_string() })),
        );
    }
}

async fn default_bind_codex_app(
    env: Option<&EnvMap>,
    rotation_enabled: bool,
    detect_desktop_app: &(dyn Fn() -> bool + Send + Sync),
    notify: &(dyn Fn(&str) + Send + Sync),
) -> Result<FirstRunStepStatus, String> {
    let current_status = get_app_bind_status(&AppBindOptions::default()).await.ok();
    let app_detected =
        detect_desktop_app() || current_status.map(|status| status.bound) == Some(true);
    if !should_bind_codex_app_on_first_run(env, rotation_enabled, app_detected) {
        return Ok(FirstRunStepStatus::Skipped);
    }
    let result = bind_codex_app_runtime_rotation(&AppBindOptions::default()).await?;
    if !result.message.is_empty() {
        notify(&result.message);
    }
    Ok(FirstRunStepStatus::Completed)
}

async fn default_install_launcher(
    env: Option<&EnvMap>,
    rotation_enabled: bool,
    notify: Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<FirstRunStepStatus, String> {
    if !should_install_codex_app_launcher_on_first_run(env, rotation_enabled) {
        return Ok(FirstRunStepStatus::Skipped);
    }
    // TS resolved the installer with a dynamic import (`loadLauncherInstall`)
    // and skipped when the script was missing; the Rust launcher is compiled
    // into this crate, so it is always present.
    install_codex_app_launcher(&AppLauncherOptions {
        log: Some(notify),
        ..AppLauncherOptions::default()
    })
    .await?;
    Ok(FirstRunStepStatus::Completed)
}

/// Runs the lazily deferred install setup (Codex app bind + launcher routing)
/// exactly once per runtime root. Never fails the caller: every error path
/// resolves with a skip/failed status and only debug-logs sanitized messages.
pub async fn ensure_first_run_setup(deps: FirstRunSetupDeps) -> FirstRunResult {
    let log = create_logger("first-run");
    match ensure_first_run_setup_inner(deps, &log).await {
        Ok(result) => result,
        Err(error) => {
            log.debug(
                "first-run setup skipped",
                Some(&serde_json::json!({ "error": error })),
            );
            FirstRunResult::Skipped(FirstRunSkipReason::Error)
        }
    }
}

async fn ensure_first_run_setup_inner(
    deps: FirstRunSetupDeps,
    log: &cma_core::logger::ScopedLogger,
) -> Result<FirstRunResult, String> {
    let env = deps.env;
    let env_ref = env.as_ref();
    if is_ci_environment(env_ref) {
        return Ok(FirstRunResult::Skipped(FirstRunSkipReason::Ci));
    }
    let installed = deps
        .installed_context
        .unwrap_or_else(|| is_installed_package_context(None, None));
    if !installed {
        return Ok(FirstRunResult::Skipped(FirstRunSkipReason::NotInstalled));
    }
    let marker_path = deps.marker_path.unwrap_or_else(get_first_run_marker_path);
    if marker_path.exists() {
        return Ok(FirstRunResult::Skipped(FirstRunSkipReason::AlreadyDone));
    }
    let now: Box<dyn Fn() -> i64 + Send + Sync> = deps.now.unwrap_or_else(|| Box::new(now_ms));
    let started_at = now();
    if !claim_first_run_marker(&marker_path, started_at).map_err(|error| error.to_string())? {
        return Ok(FirstRunResult::Skipped(FirstRunSkipReason::ClaimRace));
    }

    // Library default goes through the structured logger; the CLI entrypoint
    // passes a stderr notify so interactive users still see bind messages.
    let notify: Arc<dyn Fn(&str) + Send + Sync> = deps.notify.unwrap_or_else(|| {
        Arc::new(|message: &str| {
            create_logger("first-run").info(message, None);
        })
    });
    let detect_desktop_app: Box<dyn Fn() -> bool + Send + Sync> =
        deps.detect_desktop_app.unwrap_or_else(|| {
            let env = env.clone();
            Box::new(move || has_codex_desktop_app(env.as_ref(), None, None))
        });
    let rotation_enabled = match &deps.resolve_rotation {
        Some(resolve) => resolve(),
        None => resolve_rotation_enabled(env.as_ref(), default_read_config_rotation),
    };

    let app_bind_result = match deps.bind_codex_app {
        Some(step) => step().await,
        None => {
            default_bind_codex_app(
                env.as_ref(),
                rotation_enabled,
                detect_desktop_app.as_ref(),
                notify.as_ref(),
            )
            .await
        }
    };
    let app_bind = match app_bind_result {
        Ok(status) => status,
        Err(error) => {
            log.debug(
                "first-run app bind skipped",
                Some(&serde_json::json!({ "error": error })),
            );
            FirstRunStepStatus::Failed
        }
    };

    let launcher_result = match deps.install_launcher {
        Some(step) => step().await,
        None => default_install_launcher(env.as_ref(), rotation_enabled, notify.clone()).await,
    };
    let launcher = match launcher_result {
        Ok(status) => status,
        Err(error) => {
            log.debug(
                "first-run launcher install skipped",
                Some(&serde_json::json!({ "error": error })),
            );
            FirstRunStepStatus::Failed
        }
    };

    finalize_first_run_marker(&marker_path, started_at, app_bind, launcher, now());
    Ok(FirstRunResult::Ran { app_bind, launcher })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn env_of(pairs: &[(&str, &str)]) -> EnvMap {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn step(status: FirstRunStepStatus) -> FirstRunStep {
        Box::new(move || Box::pin(async move { Ok(status) }))
    }

    fn failing_step(message: &'static str) -> FirstRunStep {
        Box::new(move || Box::pin(async move { Err(message.to_string()) }))
    }

    // first-run.test.ts: "detects the packaged Windows Codex app from
    // LOCALAPPDATA packages"
    #[test]
    fn detects_the_packaged_windows_codex_app_from_localappdata_packages() {
        let temp = tempfile::tempdir().unwrap();
        let local_app_data = temp.path().join("Local");
        std::fs::create_dir_all(local_app_data.join("Packages").join("OpenAI.Codex_1.0_x64"))
            .unwrap();
        let env = env_of(&[("LOCALAPPDATA", &local_app_data.to_string_lossy())]);
        assert!(has_codex_desktop_app(
            Some(&env),
            Some("win32"),
            Some(temp.path())
        ));
        // Without the package entry → false.
        let empty = tempfile::tempdir().unwrap();
        let env = env_of(&[(
            "LOCALAPPDATA",
            &empty.path().join("Local").to_string_lossy(),
        )]);
        assert!(!has_codex_desktop_app(
            Some(&env),
            Some("win32"),
            Some(empty.path())
        ));
        // Non-desktop platforms → false.
        assert!(!has_codex_desktop_app(Some(&EnvMap::new()), Some("linux"), None));
    }

    // "binds the Codex app on first run only when detected with rotation
    // enabled"
    #[test]
    fn binds_only_when_detected_with_rotation_enabled() {
        let empty = EnvMap::new();
        assert!(should_bind_codex_app_on_first_run(Some(&empty), true, true));
        assert!(!should_bind_codex_app_on_first_run(Some(&empty), true, false));
        assert!(!should_bind_codex_app_on_first_run(Some(&empty), false, true));
        // Env override wins over detection.
        let on = env_of(&[("CODEX_MULTI_AUTH_APP_BIND", "1")]);
        assert!(should_bind_codex_app_on_first_run(Some(&on), false, false));
        let off = env_of(&[("CODEX_MULTI_AUTH_APP_BIND", "no")]);
        assert!(!should_bind_codex_app_on_first_run(Some(&off), true, true));
        // _INSTALL fallback override is consulted after APP_BIND.
        let install_on = env_of(&[("CODEX_MULTI_AUTH_APP_BIND_INSTALL", "yes")]);
        assert!(should_bind_codex_app_on_first_run(Some(&install_on), false, false));
        let bind_wins = env_of(&[
            ("CODEX_MULTI_AUTH_APP_BIND", "0"),
            ("CODEX_MULTI_AUTH_APP_BIND_INSTALL", "1"),
        ]);
        assert!(!should_bind_codex_app_on_first_run(Some(&bind_wins), true, true));
        // Unknown token → no override.
        let junk = env_of(&[("CODEX_MULTI_AUTH_APP_BIND", "banana")]);
        assert!(should_bind_codex_app_on_first_run(Some(&junk), true, true));
        assert!(!should_bind_codex_app_on_first_run(Some(&junk), false, true));
    }

    // "keeps CI and ignored-scripts guards ahead of explicit opt-ins"
    #[test]
    fn keeps_ci_and_ignored_scripts_guards_ahead_of_explicit_opt_ins() {
        let ci = env_of(&[("CI", "1"), ("CODEX_MULTI_AUTH_APP_BIND", "1")]);
        assert!(!should_bind_codex_app_on_first_run(Some(&ci), true, true));
        let ci = env_of(&[
            ("CI", "banana"),
            ("CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL", "1"),
        ]);
        assert!(!should_install_codex_app_launcher_on_first_run(Some(&ci), true));
        // Explicit false CI token does NOT count as CI.
        let not_ci = env_of(&[("CI", "0")]);
        assert!(!is_ci_environment(Some(&not_ci)));
        assert!(should_install_codex_app_launcher_on_first_run(Some(&not_ci), true));
        // npm_config_ignore_scripts=true counts as CI.
        let ignored = env_of(&[("npm_config_ignore_scripts", "true")]);
        assert!(is_ci_environment(Some(&ignored)));
        // CI=banana counts as CI (gotcha 13).
        let banana = env_of(&[("CI", "banana")]);
        assert!(is_ci_environment(Some(&banana)));
        assert!(!is_ci_environment(Some(&EnvMap::new())));
    }

    // "installs launcher routing on first run when rotation is enabled"
    #[test]
    fn installs_launcher_routing_when_rotation_is_enabled() {
        let empty = EnvMap::new();
        assert!(should_install_codex_app_launcher_on_first_run(Some(&empty), true));
        assert!(!should_install_codex_app_launcher_on_first_run(Some(&empty), false));
        let off = env_of(&[("CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL", "false")]);
        assert!(!should_install_codex_app_launcher_on_first_run(Some(&off), true));
        let on = env_of(&[("CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL", "1")]);
        assert!(should_install_codex_app_launcher_on_first_run(Some(&on), false));
    }

    // "resolves rotation default-on with env override and config fallback"
    #[test]
    fn resolves_rotation_default_on_with_env_override_and_config_fallback() {
        let empty = EnvMap::new();
        assert!(resolve_rotation_enabled(Some(&empty), || Ok(true)));
        assert!(!resolve_rotation_enabled(Some(&empty), || Ok(false)));
        // Config error → default TRUE (gotcha 14).
        assert!(resolve_rotation_enabled(Some(&empty), || Err(
            "boom".to_string()
        )));
        let off = env_of(&[("CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY", "0")]);
        assert!(!resolve_rotation_enabled(Some(&off), || Ok(true)));
        let on = env_of(&[("CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY", "yes")]);
        assert!(resolve_rotation_enabled(Some(&on), || Ok(false)));
        // Unknown token → no override, config wins.
        let junk = env_of(&[("CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY", "maybe")]);
        assert!(!resolve_rotation_enabled(Some(&junk), || Ok(false)));
    }

    // "only treats durable global-style installs as installed package
    // contexts" (semantics adapted to the Rust binary, see fn docs).
    #[test]
    fn only_treats_durable_installs_as_installed_package_contexts() {
        let cwd = Path::new("/work/project");
        // Durable install outside cwd → true.
        assert!(is_installed_package_context(
            Some(Path::new("/home/user/.cargo/bin/codex-multi-auth")),
            Some(cwd),
        ));
        // Cargo dev build → false.
        assert!(!is_installed_package_context(
            Some(Path::new("/repo/target/debug/codex-multi-auth")),
            Some(cwd),
        ));
        assert!(!is_installed_package_context(
            Some(Path::new("/repo/target/release/codex-multi-auth")),
            Some(cwd),
        ));
        // npx cache run → false.
        assert!(!is_installed_package_context(
            Some(Path::new("/home/user/.npm/_npx/abc123/node_modules/.bin/codex-multi-auth")),
            Some(cwd),
        ));
        // Project-local (inside cwd) → false.
        assert!(!is_installed_package_context(
            Some(Path::new("/work/project/bin/codex-multi-auth")),
            Some(cwd),
        ));
    }

    // "runs setup once and records the outcome in the marker"
    #[tokio::test]
    async fn runs_setup_once_and_records_the_outcome_in_the_marker() {
        let temp = tempfile::tempdir().unwrap();
        let marker_path = temp.path().join("mad").join(FIRST_RUN_MARKER_FILE);
        let result = ensure_first_run_setup(FirstRunSetupDeps {
            env: Some(EnvMap::new()),
            marker_path: Some(marker_path.clone()),
            installed_context: Some(true),
            bind_codex_app: Some(step(FirstRunStepStatus::Completed)),
            install_launcher: Some(step(FirstRunStepStatus::Skipped)),
            now: Some(Box::new(|| 777)),
            ..FirstRunSetupDeps::default()
        })
        .await;
        assert_eq!(
            result,
            FirstRunResult::Ran {
                app_bind: FirstRunStepStatus::Completed,
                launcher: FirstRunStepStatus::Skipped,
            }
        );
        let raw = std::fs::read_to_string(&marker_path).unwrap();
        // TAB-indented, trailing newline, exact field set.
        assert!(raw.starts_with("{\n\t\"version\": 1"));
        assert!(raw.ends_with("\n"));
        assert!(raw.contains("\t\"startedAt\": 777"));
        assert!(raw.contains("\t\"completedAt\": 777"));
        assert!(raw.contains("\t\"appBind\": \"completed\""));
        assert!(raw.contains("\t\"launcher\": \"skipped\""));
    }

    // "skips setup on the second run once the marker exists"
    #[tokio::test]
    async fn skips_setup_on_the_second_run_once_the_marker_exists() {
        let temp = tempfile::tempdir().unwrap();
        let marker_path = temp.path().join(FIRST_RUN_MARKER_FILE);
        let deps = || FirstRunSetupDeps {
            env: Some(EnvMap::new()),
            marker_path: Some(marker_path.clone()),
            installed_context: Some(true),
            bind_codex_app: Some(step(FirstRunStepStatus::Completed)),
            install_launcher: Some(step(FirstRunStepStatus::Completed)),
            ..FirstRunSetupDeps::default()
        };
        let first = ensure_first_run_setup(deps()).await;
        assert!(matches!(first, FirstRunResult::Ran { .. }));
        let second = ensure_first_run_setup(deps()).await;
        assert_eq!(
            second,
            FirstRunResult::Skipped(FirstRunSkipReason::AlreadyDone)
        );
    }

    // "runs setup at most once under concurrent first invocations" — the
    // claim itself is the cross-process gate.
    #[test]
    fn claim_marker_is_exclusive() {
        let temp = tempfile::tempdir().unwrap();
        let marker_path = temp.path().join("nested").join(FIRST_RUN_MARKER_FILE);
        assert!(claim_first_run_marker(&marker_path, 1).unwrap());
        assert!(!claim_first_run_marker(&marker_path, 2).unwrap());
        let raw = std::fs::read_to_string(&marker_path).unwrap();
        assert_eq!(raw, "{\n\t\"version\": 1,\n\t\"startedAt\": 1\n}\n");
    }

    // "never fails the command when setup steps throw, and still writes the
    // marker"
    #[tokio::test]
    async fn never_fails_when_setup_steps_error_and_still_writes_the_marker() {
        let temp = tempfile::tempdir().unwrap();
        let marker_path = temp.path().join(FIRST_RUN_MARKER_FILE);
        let result = ensure_first_run_setup(FirstRunSetupDeps {
            env: Some(EnvMap::new()),
            marker_path: Some(marker_path.clone()),
            installed_context: Some(true),
            bind_codex_app: Some(failing_step("bind exploded")),
            install_launcher: Some(failing_step("launcher exploded")),
            ..FirstRunSetupDeps::default()
        })
        .await;
        assert_eq!(
            result,
            FirstRunResult::Ran {
                app_bind: FirstRunStepStatus::Failed,
                launcher: FirstRunStepStatus::Failed,
            }
        );
        let raw = std::fs::read_to_string(&marker_path).unwrap();
        assert!(raw.contains("\"appBind\": \"failed\""));
        assert!(raw.contains("\"launcher\": \"failed\""));
    }

    // "resolves instead of throwing when even the marker claim fails"
    #[tokio::test]
    async fn resolves_instead_of_throwing_when_even_the_marker_claim_fails() {
        let temp = tempfile::tempdir().unwrap();
        // Marker path IS a directory → exists() false? No: a dir exists().
        // Use a path whose parent is a FILE so mkdir fails.
        let blocker = temp.path().join("blocker");
        std::fs::write(&blocker, "x").unwrap();
        let marker_path = blocker.join(FIRST_RUN_MARKER_FILE);
        let result = ensure_first_run_setup(FirstRunSetupDeps {
            env: Some(EnvMap::new()),
            marker_path: Some(marker_path),
            installed_context: Some(true),
            bind_codex_app: Some(step(FirstRunStepStatus::Completed)),
            install_launcher: Some(step(FirstRunStepStatus::Completed)),
            ..FirstRunSetupDeps::default()
        })
        .await;
        assert_eq!(result, FirstRunResult::Skipped(FirstRunSkipReason::Error));
    }

    // "skips entirely in CI without creating the marker"
    #[tokio::test]
    async fn skips_entirely_in_ci_without_creating_the_marker() {
        let temp = tempfile::tempdir().unwrap();
        let marker_path = temp.path().join(FIRST_RUN_MARKER_FILE);
        let result = ensure_first_run_setup(FirstRunSetupDeps {
            env: Some(env_of(&[("CI", "true")])),
            marker_path: Some(marker_path.clone()),
            installed_context: Some(true),
            ..FirstRunSetupDeps::default()
        })
        .await;
        assert_eq!(result, FirstRunResult::Skipped(FirstRunSkipReason::Ci));
        assert!(!marker_path.exists());
    }

    // "skips outside installed package contexts without touching the
    // filesystem"
    #[tokio::test]
    async fn skips_outside_installed_package_contexts_without_touching_the_filesystem() {
        let temp = tempfile::tempdir().unwrap();
        let marker_path = temp.path().join(FIRST_RUN_MARKER_FILE);
        let result = ensure_first_run_setup(FirstRunSetupDeps {
            env: Some(EnvMap::new()),
            marker_path: Some(marker_path.clone()),
            installed_context: Some(false),
            ..FirstRunSetupDeps::default()
        })
        .await;
        assert_eq!(
            result,
            FirstRunResult::Skipped(FirstRunSkipReason::NotInstalled)
        );
        assert!(!marker_path.exists());
    }

    #[test]
    fn read_optional_boolean_tri_state() {
        assert_eq!(read_optional_boolean(None), None);
        assert_eq!(read_optional_boolean(Some("")), None);
        assert_eq!(read_optional_boolean(Some("  ")), None);
        assert_eq!(read_optional_boolean(Some("1")), Some(true));
        assert_eq!(read_optional_boolean(Some("TRUE")), Some(true));
        assert_eq!(read_optional_boolean(Some(" yes ")), Some(true));
        assert_eq!(read_optional_boolean(Some("0")), Some(false));
        assert_eq!(read_optional_boolean(Some("False")), Some(false));
        assert_eq!(read_optional_boolean(Some("no")), Some(false));
        assert_eq!(read_optional_boolean(Some("banana")), None);
    }

    #[test]
    #[serial(env)]
    fn is_ci_environment_reads_process_env_when_no_map_given() {
        let mut sandbox = cma_testkit::sandbox::EnvSandbox::new();
        for key in CI_ENV_KEYS {
            sandbox.remove_var(key);
        }
        sandbox.remove_var("npm_config_ignore_scripts");
        assert!(!is_ci_environment(None));
        sandbox.set_var("CI", "1");
        assert!(is_ci_environment(None));
    }
}
