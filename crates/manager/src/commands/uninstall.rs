//! Port of `lib/codex-manager/commands/uninstall.ts`.
//!
//! `uninstall [--dry-run] [--json] [--clear-accounts]` — reverses all
//! first-run setup changes: unbinds the Codex app, removes OS launchers,
//! strips the plugin from Codex.json, and clears the plugin cache.
//!
//! CRITICAL contracts (spec 08 §4.18 / gotcha 19):
//! - Codex.json is rewritten as `JSON.stringify(config, null, "\t") + "\n"`
//!   — TAB indent + trailing LF, byte format matters;
//! - the shared bun.lock is deleted ONLY when the plugin list is provably
//!   empty (ENOENT ⇒ safe; parse error / missing `plugins` / non-empty list
//!   ⇒ keep);
//! - the default log sink is STDERR with the `codex-multi-auth: ` prefix;
//! - `--clear-accounts` without a wired handler is a partial failure, never
//!   a silent no-op;
//! - JSON output is COMPACT; exit code is `partialFailure ? 1 : 0`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cma_core::errors::CodexError;
use cma_core::fs_retry::{code_of, with_file_operation_retry};
use cma_core::json_io::{stringify_compact, stringify_pretty_tab};
use serde_json::{Map, Value};

use crate::dispatcher::CliOut;
use crate::forecast_report_shared::BoxFuture;

const PLUGIN_NAME: &str = "codex-multi-auth";

// ============================================================================
// Paths
// ============================================================================

/// TS `resolveUninstallPaths(platform, env, home)` return shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UninstallPaths {
    pub config_path: PathBuf,
    pub cache_node_modules: PathBuf,
    pub cache_bun_lock: PathBuf,
}

/// TS `resolveUninstallPaths(platform, env, home)`.
pub fn resolve_uninstall_paths(
    platform: &str,
    env: &HashMap<String, String>,
    home: &Path,
) -> UninstallPaths {
    let is_windows = platform == "win32";
    let app_data = env
        .get("APPDATA")
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let local_app_data = env
        .get("LOCALAPPDATA")
        .or(env.get("APPDATA"))
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let config_base = if is_windows {
        if app_data.is_empty() {
            home.join("AppData").join("Roaming")
        } else {
            PathBuf::from(app_data)
        }
    } else {
        home.join(".config")
    };
    let cache_base = if is_windows {
        if local_app_data.is_empty() {
            home.join("AppData").join("Local")
        } else {
            PathBuf::from(local_app_data)
        }
    } else {
        home.join(".cache")
    };
    let config_dir = config_base.join("Codex");
    let cache_dir = cache_base.join("Codex");
    UninstallPaths {
        config_path: config_dir.join("Codex.json"),
        cache_node_modules: cache_dir.join("node_modules").join(PLUGIN_NAME),
        cache_bun_lock: cache_dir.join("bun.lock"),
    }
}

fn current_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// `os.homedir()` analogue via the env ladder (spec 02 §2.1 — env vars
/// first; the `home` crate is not a cma-manager dependency).
fn default_home_dir() -> PathBuf {
    let non_blank = |key: &str| {
        std::env::var(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    if cfg!(windows) {
        if let Some(profile) = non_blank("USERPROFILE") {
            return PathBuf::from(profile);
        }
        if let Some(home) = non_blank("HOME") {
            return PathBuf::from(home);
        }
        if let (Some(drive), Some(path)) = (non_blank("HOMEDRIVE"), non_blank("HOMEPATH")) {
            return PathBuf::from(format!("{drive}{path}"));
        }
    } else if let Some(home) = non_blank("HOME") {
        return PathBuf::from(home);
    }
    PathBuf::new()
}

fn default_paths() -> UninstallPaths {
    let env: HashMap<String, String> = std::env::vars().collect();
    resolve_uninstall_paths(current_platform(), &env, &default_home_dir())
}

// ============================================================================
// Plugin list filtering
// ============================================================================

/// JS truthiness over a JSON value (`list.filter(Boolean)`).
fn is_js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// TS `removePluginFromList(list)` — pre-filter falsy entries (matching
/// `scripts/install-codex-auth-utils.js`), then drop string entries equal to
/// `codex-multi-auth` or starting with `codex-multi-auth@`; non-strings are
/// kept.
pub fn remove_plugin_from_list(list: &[Value]) -> Vec<Value> {
    list.iter()
        .filter(|entry| is_js_truthy(entry))
        .filter(|entry| match entry.as_str() {
            Some(text) => text != PLUGIN_NAME && !text.starts_with(&format!("{PLUGIN_NAME}@")),
            None => true,
        })
        .cloned()
        .collect()
}

// ============================================================================
// Arg parsing
// ============================================================================

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct UninstallCliOptions {
    dry_run: bool,
    json: bool,
    clear_accounts: bool,
}

fn print_uninstall_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage:",
            "  codex-multi-auth uninstall [--dry-run] [--json] [--clear-accounts]",
            "",
            "Options:",
            "  --dry-run          Show what would be removed without making changes",
            "  --json             Print machine-readable JSON output",
            "  --clear-accounts   Also remove stored account credentials (irreversible)",
            "",
            "Behavior:",
            "  Reverses all first-run setup changes: unbinds Codex app, removes OS launchers,",
            "  strips plugin from Codex.json, and clears the plugin cache.",
            "",
            "Recommended order (npm@7+ no longer fires preuninstall lifecycle scripts,",
            "so cleanup must be initiated manually):",
            "  1. codex-multi-auth uninstall          # remove residual artifacts",
            "  2. npm uninstall -g codex-multi-auth   # remove the package itself",
        ]
        .join("\n"),
    );
}

enum ParsedUninstallArgs {
    Ok(UninstallCliOptions),
    Help,
    Error(String),
}

/// TS `parseUninstallArgs(args)`.
fn parse_uninstall_args(args: &[String]) -> ParsedUninstallArgs {
    let mut options = UninstallCliOptions::default();
    for arg in args {
        match arg.as_str() {
            "--help" | "-h" => return ParsedUninstallArgs::Help,
            "--dry-run" => options.dry_run = true,
            "--json" | "-j" => options.json = true,
            "--clear-accounts" => options.clear_accounts = true,
            other => return ParsedUninstallArgs::Error(format!("Unknown option: {other}")),
        }
    }
    ParsedUninstallArgs::Ok(options)
}

// ============================================================================
// Deps
// ============================================================================

/// TS `UninstallCommandDeps`.
#[allow(clippy::type_complexity)] // boxed DI seams mirror the TS deps object 1:1
pub struct UninstallCommandDeps {
    /// Extra log sink (TS `deps.log`); `None` = stderr with the
    /// `codex-multi-auth: ` prefix via the command's [`CliOut`].
    pub log: Option<Box<dyn Fn(&str) + Send + Sync>>,
    /// `--clear-accounts` handler (wired to real storage clearing by
    /// default — the dispatcher passes `clearAccounts`).
    pub clear_accounts: Option<Box<dyn Fn() -> BoxFuture<Result<(), CodexError>> + Send + Sync>>,
    pub unbind: Option<Box<dyn Fn() -> BoxFuture<Result<(), String>> + Send + Sync>>,
    pub remove_launcher: Option<Box<dyn Fn() -> BoxFuture<Result<(), String>> + Send + Sync>>,
    pub paths: Option<UninstallPaths>,
}

impl Default for UninstallCommandDeps {
    fn default() -> Self {
        UninstallCommandDeps {
            log: None,
            clear_accounts: Some(Box::new(|| {
                Box::pin(async {
                    cma_storage::clear::clear_accounts()
                        .await
                        .map_err(|error| CodexError::new(error.to_string()))
                })
            })),
            unbind: None,
            remove_launcher: None,
            paths: None,
        }
    }
}

/// Node `rm(path, { recursive: true, force: true })` — removes a file or a
/// directory tree; missing targets are fine.
async fn rm_recursive_force(path: &Path) -> std::io::Result<()> {
    match tokio::fs::metadata(path).await {
        Ok(metadata) => {
            if metadata.is_dir() {
                tokio::fs::remove_dir_all(path).await
            } else {
                tokio::fs::remove_file(path).await
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Node `rm(path, { force: true })` (non-recursive).
async fn rm_force(path: &Path) -> std::io::Result<()> {
    match tokio::fs::remove_file(path).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

// ============================================================================
// runUninstallCommand
// ============================================================================

/// Production entry (dispatcher wiring — `clearAccounts` is wired).
pub async fn run_uninstall_command(args: &[String], out: &mut CliOut) -> i32 {
    run_uninstall_command_with(args, &UninstallCommandDeps::default(), out).await
}

/// TS `runUninstallCommand(args, deps)`.
pub async fn run_uninstall_command_with(
    args: &[String],
    deps: &UninstallCommandDeps,
    out: &mut CliOut,
) -> i32 {
    let options = match parse_uninstall_args(args) {
        ParsedUninstallArgs::Ok(options) => options,
        ParsedUninstallArgs::Help => {
            print_uninstall_usage(out);
            return 0;
        }
        ParsedUninstallArgs::Error(message) => {
            out.error(format!("codex-multi-auth uninstall: {message}"));
            out.error("Run \"codex-multi-auth uninstall --help\" for usage.");
            return 1;
        }
    };

    let dry_run = options.dry_run;
    let json = options.json;
    let clear_accounts_flag = options.clear_accounts;
    let paths = deps.paths.clone().unwrap_or_else(default_paths);
    let mut removed: Vec<&'static str> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut partial_failure = false;

    // TS default sink = stderr with the "codex-multi-auth: " prefix.
    macro_rules! log {
        ($msg:expr) => {{
            let message: String = $msg;
            match &deps.log {
                Some(log) => log(&message),
                None => out.error(format!("codex-multi-auth: {message}")),
            }
        }};
    }

    // Surface a missing --clear-accounts handler immediately: silently
    // no-oping would leave the user believing tokens were removed.
    if clear_accounts_flag && deps.clear_accounts.is_none() {
        let msg =
            "--clear-accounts has no effect: no clearAccounts handler is wired in this build";
        log!(format!("warning: {msg}"));
        warnings.push(msg.to_string());
        partial_failure = true;
    }

    // Unbind Codex app runtime rotation.
    let unbind_result: Result<(), String> = if dry_run {
        log!("[dry-run] Would unbind Codex app runtime rotation".to_string());
        Ok(())
    } else {
        let result = match &deps.unbind {
            Some(unbind) => unbind().await,
            None => cma_runtime::app_bind::unbind_codex_app_runtime_rotation(
                &cma_runtime::app_bind::AppBindOptions::default(),
            )
            .await
            .map(|_| ()),
        };
        if result.is_ok() {
            removed.push("app-bind");
        }
        result
    };
    if let Err(error) = unbind_result {
        let msg = format!("app unbind skipped: {error}");
        log!(msg.clone());
        warnings.push(msg);
        partial_failure = true;
    }

    // Remove OS-level launcher (loaded lazily in TS so dry-run needs no
    // dist file; the Rust launcher is a library call).
    let launcher_result: Result<(), String> = if dry_run {
        log!("[dry-run] Would remove OS launcher".to_string());
        Ok(())
    } else {
        let result = match &deps.remove_launcher {
            Some(remove_launcher) => remove_launcher().await,
            None => {
                let sink: cma_runtime::app_launcher::SharedLogSink =
                    Arc::new(|message: &str| eprintln!("codex-multi-auth: {message}"));
                cma_runtime::app_launcher::install_codex_app_launcher(
                    &cma_runtime::app_launcher::AppLauncherOptions {
                        remove: true,
                        log: Some(sink),
                        ..Default::default()
                    },
                )
                .await
                .map(|_| ())
            }
        };
        if result.is_ok() {
            removed.push("launcher");
        }
        result
    };
    if let Err(error) = launcher_result {
        let msg = format!("launcher removal skipped: {error}");
        log!(msg.clone());
        warnings.push(msg);
        partial_failure = true;
    }

    // Remove the plugin entry from Codex.json and decide whether the SHARED
    // bun.lock is safe to delete. Decision table:
    //   - File ENOENT             → safe (nothing to protect)
    //   - Parse error / read fail → NOT safe (unknown state, be conservative)
    //   - File ok, no plugins[]   → NOT safe (we don't know what's installed)
    //   - File ok, plugins[]=[]   → safe
    //   - File ok, plugins[]≠[]   → NOT safe
    let mut bun_lock_safe = false;
    let config_step: Result<(), String> = async {
        let read_result = with_file_operation_retry(|| async {
            tokio::fs::read_to_string(&paths.config_path).await
        })
        .await;
        let raw = match read_result {
            Ok(raw) => raw,
            Err(error) => {
                if code_of(&error) == Some("ENOENT") {
                    bun_lock_safe = true;
                    if dry_run {
                        log!(format!(
                            "[dry-run] Would remove {PLUGIN_NAME} from {}",
                            paths.config_path.display()
                        ));
                    }
                    return Ok(());
                }
                return Err(error.to_string());
            }
        };
        let mut config: Value =
            serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        let plugins = config
            .as_object()
            .and_then(|object| object.get("plugins"))
            .and_then(Value::as_array)
            .cloned();
        match plugins {
            Some(plugins) => {
                let next = remove_plugin_from_list(&plugins);
                bun_lock_safe = next.is_empty();
                if dry_run {
                    log!(format!(
                        "[dry-run] Would remove {PLUGIN_NAME} from {}",
                        paths.config_path.display()
                    ));
                } else {
                    if let Some(object) = config.as_object_mut() {
                        object.insert("plugins".to_string(), Value::Array(next));
                    }
                    let contents = format!("{}\n", stringify_pretty_tab(&config));
                    with_file_operation_retry(|| async {
                        tokio::fs::write(&paths.config_path, contents.as_bytes()).await
                    })
                    .await
                    .map_err(|error| error.to_string())?;
                    removed.push("config-entry");
                }
            }
            None => {
                if dry_run {
                    log!(format!(
                        "[dry-run] Would remove {PLUGIN_NAME} from {}",
                        paths.config_path.display()
                    ));
                }
            }
        }
        Ok(())
    }
    .await;
    if let Err(error) = config_step {
        let msg = format!("config cleanup skipped: {error}");
        log!(msg.clone());
        warnings.push(msg);
        partial_failure = true;
    }

    // Cache clear — bun.lock only when provably safe (shared across all
    // Codex plugins).
    let cache_step: Result<(), String> = async {
        if dry_run {
            log!(format!(
                "[dry-run] Would remove {}",
                paths.cache_node_modules.display()
            ));
            if bun_lock_safe {
                log!(format!(
                    "[dry-run] Would remove {}",
                    paths.cache_bun_lock.display()
                ));
            } else {
                log!(format!(
                    "[dry-run] Would skip {} (other plugins still installed)",
                    paths.cache_bun_lock.display()
                ));
            }
            return Ok(());
        }
        with_file_operation_retry(|| async { rm_recursive_force(&paths.cache_node_modules).await })
            .await
            .map_err(|error| error.to_string())?;
        if bun_lock_safe {
            with_file_operation_retry(|| async { rm_force(&paths.cache_bun_lock).await })
                .await
                .map_err(|error| error.to_string())?;
        }
        removed.push("cache");
        Ok(())
    }
    .await;
    if let Err(error) = cache_step {
        let msg = format!("cache clear skipped: {error}");
        log!(msg.clone());
        warnings.push(msg);
        partial_failure = true;
    }

    // Optionally clear stored accounts.
    if clear_accounts_flag && let Some(clear_accounts) = &deps.clear_accounts {
        let clear_step: Result<(), String> = if dry_run {
            log!("[dry-run] Would clear stored account credentials".to_string());
            Ok(())
        } else {
            let result = clear_accounts()
                .await
                .map_err(|error| error.message().to_string());
            if result.is_ok() {
                removed.push("accounts");
            }
            result
        };
        if let Err(error) = clear_step {
            let msg = format!("account clear skipped: {error}");
            log!(msg.clone());
            warnings.push(msg);
            partial_failure = true;
        }
    }

    if json {
        let mut payload = Map::new();
        payload.insert("dryRun".into(), Value::from(dry_run));
        payload.insert(
            "removed".into(),
            Value::Array(removed.iter().map(|step| Value::from(*step)).collect()),
        );
        payload.insert(
            "warnings".into(),
            Value::Array(warnings.iter().cloned().map(Value::from).collect()),
        );
        payload.insert("ok".into(), Value::from(!partial_failure));
        out.info(stringify_compact(&Value::Object(payload)));
    } else if !dry_run {
        let summary = if removed.is_empty() {
            "nothing to remove".to_string()
        } else {
            removed.join(", ")
        };
        log!(format!("uninstall complete: {summary}"));
        if !warnings.is_empty() {
            log!(format!(
                "warnings: {} step(s) skipped (see above)",
                warnings.len()
            ));
        }
    }

    if partial_failure { 1 } else { 0 }
}

// ============================================================================
// Tests — ported from test/uninstall-command.test.ts +
// test/uninstall-ebusy-retry.test.ts (core decision table)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn noop_deps(paths: UninstallPaths) -> UninstallCommandDeps {
        UninstallCommandDeps {
            log: None,
            clear_accounts: Some(Box::new(|| Box::pin(async { Ok(()) }))),
            unbind: Some(Box::new(|| Box::pin(async { Ok(()) }))),
            remove_launcher: Some(Box::new(|| Box::pin(async { Ok(()) }))),
            paths: Some(paths),
        }
    }

    fn temp_paths(dir: &Path) -> UninstallPaths {
        UninstallPaths {
            config_path: dir.join("Codex").join("Codex.json"),
            cache_node_modules: dir.join("cache").join("node_modules").join(PLUGIN_NAME),
            cache_bun_lock: dir.join("cache").join("bun.lock"),
        }
    }

    #[test]
    fn resolve_paths_win32_honors_appdata_with_fallbacks() {
        let home = Path::new("C:/Users/dev");
        let paths = resolve_uninstall_paths(
            "win32",
            &env(&[("APPDATA", "C:/Roaming"), ("LOCALAPPDATA", "C:/Local")]),
            home,
        );
        assert_eq!(paths.config_path, PathBuf::from("C:/Roaming/Codex/Codex.json"));
        assert_eq!(
            paths.cache_node_modules,
            PathBuf::from("C:/Local/Codex/node_modules/codex-multi-auth")
        );
        assert_eq!(paths.cache_bun_lock, PathBuf::from("C:/Local/Codex/bun.lock"));

        // LOCALAPPDATA falls back to APPDATA; both fall back to home.
        let fallback = resolve_uninstall_paths("win32", &env(&[("APPDATA", "C:/Roaming")]), home);
        assert_eq!(fallback.cache_bun_lock, PathBuf::from("C:/Roaming/Codex/bun.lock"));
        let bare = resolve_uninstall_paths("win32", &env(&[]), home);
        assert_eq!(
            bare.config_path,
            home.join("AppData").join("Roaming").join("Codex").join("Codex.json")
        );
        assert_eq!(
            bare.cache_bun_lock,
            home.join("AppData").join("Local").join("Codex").join("bun.lock")
        );
    }

    #[test]
    fn resolve_paths_posix_uses_config_and_cache() {
        let home = Path::new("/home/dev");
        let paths = resolve_uninstall_paths("linux", &env(&[]), home);
        assert_eq!(paths.config_path, PathBuf::from("/home/dev/.config/Codex/Codex.json"));
        assert_eq!(paths.cache_bun_lock, PathBuf::from("/home/dev/.cache/Codex/bun.lock"));
    }

    #[test]
    fn remove_plugin_from_list_filters_falsy_and_versioned_entries() {
        let list = vec![
            json!("codex-multi-auth"),
            json!("codex-multi-auth@1.2.3"),
            json!("other-plugin"),
            json!(null),
            json!(""),
            json!(false),
            json!(0),
            json!(42),
            json!({ "name": "keep-object" }),
        ];
        let next = remove_plugin_from_list(&list);
        assert_eq!(
            next,
            vec![json!("other-plugin"), json!(42), json!({ "name": "keep-object" })]
        );
        // A different plugin sharing the prefix without `@` is kept.
        let kept = remove_plugin_from_list(&[json!("codex-multi-auth-extras")]);
        assert_eq!(kept, vec![json!("codex-multi-auth-extras")]);
    }

    #[tokio::test]
    async fn unknown_option_prints_prefixed_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let deps = noop_deps(temp_paths(dir.path()));
        let mut out = CliOut::capture();
        let code = run_uninstall_command_with(&args(&["--bogus"]), &deps, &mut out).await;
        assert_eq!(code, 1);
        let errors = out.error_text();
        assert!(errors.contains("codex-multi-auth uninstall: Unknown option: --bogus"));
        assert!(errors.contains("Run \"codex-multi-auth uninstall --help\" for usage."));
    }

    #[tokio::test]
    async fn dry_run_logs_previews_and_writes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = temp_paths(dir.path());
        std::fs::create_dir_all(paths.config_path.parent().unwrap()).unwrap();
        std::fs::write(
            &paths.config_path,
            "{\n\t\"plugins\": [\"codex-multi-auth\", \"other\"]\n}\n",
        )
        .unwrap();
        let deps = noop_deps(paths.clone());
        let mut out = CliOut::capture();
        let code = run_uninstall_command_with(&args(&["--dry-run", "--json"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        // Compact JSON on stdout.
        assert_eq!(
            out.info_text(),
            "{\"dryRun\":true,\"removed\":[],\"warnings\":[],\"ok\":true}"
        );
        // Non-empty remainder → bun.lock skip preview on stderr.
        let errors = out.error_text();
        assert!(errors.contains("[dry-run] Would unbind Codex app runtime rotation"));
        assert!(errors.contains("(other plugins still installed)"));
        // Nothing was modified.
        let raw = std::fs::read_to_string(&paths.config_path).unwrap();
        assert!(raw.contains("codex-multi-auth"));
    }

    #[tokio::test]
    async fn rewrites_codex_json_with_tab_indent_and_trailing_newline() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = temp_paths(dir.path());
        std::fs::create_dir_all(paths.config_path.parent().unwrap()).unwrap();
        std::fs::write(
            &paths.config_path,
            "{\"plugins\":[\"codex-multi-auth@2.7.1\",\"other\"],\"theme\":\"dark\"}",
        )
        .unwrap();
        std::fs::create_dir_all(&paths.cache_node_modules).unwrap();
        std::fs::write(&paths.cache_bun_lock, "lock").unwrap();
        let deps = noop_deps(paths.clone());
        let mut out = CliOut::capture();
        let code = run_uninstall_command_with(&args(&["--json"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["ok"], Value::from(true));
        assert_eq!(
            payload["removed"],
            json!(["app-bind", "launcher", "config-entry", "cache"])
        );
        // TAB-indented + trailing newline, unknown keys preserved in place.
        let written = std::fs::read_to_string(&paths.config_path).unwrap();
        assert_eq!(
            written,
            "{\n\t\"plugins\": [\n\t\t\"other\"\n\t],\n\t\"theme\": \"dark\"\n}\n"
        );
        // Remainder non-empty → shared bun.lock kept.
        assert!(paths.cache_bun_lock.exists());
        assert!(!paths.cache_node_modules.exists());
    }

    #[tokio::test]
    async fn bun_lock_removed_only_when_plugin_list_provably_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = temp_paths(dir.path());
        std::fs::create_dir_all(paths.config_path.parent().unwrap()).unwrap();
        std::fs::write(&paths.config_path, "{\"plugins\":[\"codex-multi-auth\"]}").unwrap();
        std::fs::create_dir_all(paths.cache_bun_lock.parent().unwrap()).unwrap();
        std::fs::write(&paths.cache_bun_lock, "lock").unwrap();
        let deps = noop_deps(paths.clone());
        let mut out = CliOut::capture();
        let code = run_uninstall_command_with(&args(&["--json"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        assert!(!paths.cache_bun_lock.exists());
    }

    #[tokio::test]
    async fn enoent_config_is_safe_but_parse_error_is_conservative() {
        // ENOENT → safe → bun.lock removed.
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = temp_paths(dir.path());
        std::fs::create_dir_all(paths.cache_bun_lock.parent().unwrap()).unwrap();
        std::fs::write(&paths.cache_bun_lock, "lock").unwrap();
        let deps = noop_deps(paths.clone());
        let mut out = CliOut::capture();
        let code = run_uninstall_command_with(&args(&["--json"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        assert!(!paths.cache_bun_lock.exists());

        // Parse error → uncertain → bun.lock kept, warning + exit 1.
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = temp_paths(dir.path());
        std::fs::create_dir_all(paths.config_path.parent().unwrap()).unwrap();
        std::fs::write(&paths.config_path, "{not json").unwrap();
        std::fs::create_dir_all(paths.cache_bun_lock.parent().unwrap()).unwrap();
        std::fs::write(&paths.cache_bun_lock, "lock").unwrap();
        let deps = noop_deps(paths.clone());
        let mut out = CliOut::capture();
        let code = run_uninstall_command_with(&args(&["--json"]), &deps, &mut out).await;
        assert_eq!(code, 1);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["ok"], Value::from(false));
        assert!(
            payload["warnings"][0]
                .as_str()
                .unwrap()
                .starts_with("config cleanup skipped: ")
        );
        assert!(paths.cache_bun_lock.exists());
    }

    #[tokio::test]
    async fn clear_accounts_without_handler_is_partial_failure() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut deps = noop_deps(temp_paths(dir.path()));
        deps.clear_accounts = None;
        let mut out = CliOut::capture();
        let code =
            run_uninstall_command_with(&args(&["--clear-accounts", "--json"]), &deps, &mut out)
                .await;
        assert_eq!(code, 1);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["ok"], Value::from(false));
        assert_eq!(
            payload["warnings"][0],
            Value::from(
                "--clear-accounts has no effect: no clearAccounts handler is wired in this build"
            )
        );
        assert!(
            out.error_text().contains(
                "codex-multi-auth: warning: --clear-accounts has no effect"
            )
        );
    }

    #[tokio::test]
    async fn text_mode_logs_summary_through_stderr_sink() {
        let dir = tempfile::tempdir().expect("tempdir");
        let deps = noop_deps(temp_paths(dir.path()));
        let mut out = CliOut::capture();
        let code = run_uninstall_command_with(&[], &deps, &mut out).await;
        assert_eq!(code, 0);
        assert_eq!(out.info_text(), "");
        assert!(
            out.error_text()
                .contains("codex-multi-auth: uninstall complete: app-bind, launcher, cache")
        );
    }
}
