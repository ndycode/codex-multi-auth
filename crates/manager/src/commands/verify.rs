//! Port of `lib/codex-manager/commands/verify.ts`.
//!
//! Behavior source: spec 08 §4.21 (+ gotcha 20): the sandbox escape probe
//! must reject with a message matching `/access denied/i`; a rejection with a
//! different message is a FAILURE. Escape candidates must be verified outside
//! home/tmp/projectRoot; when impossible, the test records ok+skipped.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::dispatcher::CliOut;
use crate::forecast_report_shared::{default_set_storage_path, BoxFuture, SetStoragePathFn};

/// TS `VerifyCliOptions`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VerifyCliOptions {
    pub json: bool,
    pub paths: bool,
    pub flagged: bool,
    pub all: bool,
}

/// One `Path chain` step.
#[derive(Clone, Debug, PartialEq)]
pub struct VerifyPathStep {
    pub name: String,
    pub input: Option<String>,
    pub output: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
}

/// One sandbox test result.
#[derive(Clone, Debug, PartialEq)]
pub struct VerifySandboxResult {
    pub name: String,
    pub input: String,
    pub rejected: bool,
    pub ok: bool,
    pub error: Option<String>,
}

/// TS `VerifyPathsReport`.
#[derive(Clone, Debug, PartialEq)]
pub struct VerifyPathsReport {
    pub ok: bool,
    pub steps: Vec<VerifyPathStep>,
    pub sandbox_tests: Vec<VerifySandboxResult>,
}

/// TS `VerifyPathsDeps`.
#[allow(clippy::type_complexity)] // boxed DI seams mirror the TS deps object 1:1
pub struct VerifyPathsDeps {
    pub get_cwd: Box<dyn Fn() -> PathBuf + Send + Sync>,
    pub find_project_root: Box<dyn Fn(&Path) -> Option<PathBuf> + Send + Sync>,
    pub resolve_project_storage_identity_root: Box<dyn Fn(&Path) -> PathBuf + Send + Sync>,
    pub get_project_storage_key: Box<dyn Fn(&Path) -> String + Send + Sync>,
    pub get_project_config_dir: Box<dyn Fn(&Path) -> PathBuf + Send + Sync>,
    pub get_project_global_config_dir: Box<dyn Fn(&Path) -> PathBuf + Send + Sync>,
    pub resolve_path: Box<dyn Fn(&str) -> Result<PathBuf, String> + Send + Sync>,
    /// `os.homedir()` / `os.tmpdir()` seams for the sandbox candidates.
    pub homedir: Box<dyn Fn() -> PathBuf + Send + Sync>,
    pub tmpdir: Box<dyn Fn() -> PathBuf + Send + Sync>,
}

impl Default for VerifyPathsDeps {
    fn default() -> Self {
        VerifyPathsDeps {
            get_cwd: Box::new(|| std::env::current_dir().unwrap_or_default()),
            find_project_root: Box::new(cma_storage::paths::find_project_root),
            resolve_project_storage_identity_root: Box::new(
                cma_storage::paths::resolve_project_storage_identity_root,
            ),
            get_project_storage_key: Box::new(cma_storage::paths::get_project_storage_key),
            get_project_config_dir: Box::new(cma_storage::paths::get_project_config_dir),
            get_project_global_config_dir: Box::new(
                cma_storage::paths::get_project_global_config_dir,
            ),
            resolve_path: Box::new(|input| {
                cma_storage::paths::resolve_path(input).map_err(|error| error.0)
            }),
            homedir: Box::new(default_homedir),
            tmpdir: Box::new(std::env::temp_dir),
        }
    }
}

fn default_homedir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE")
            && !profile.trim().is_empty()
        {
            return PathBuf::from(profile);
        }
        if let Ok(home) = std::env::var("HOME")
            && !home.trim().is_empty()
        {
            return PathBuf::from(home);
        }
        if let (Ok(drive), Ok(path)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH"))
            && !drive.trim().is_empty()
            && !path.trim().is_empty()
        {
            return PathBuf::from(format!("{drive}{path}"));
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME")
            && !home.trim().is_empty()
        {
            return PathBuf::from(home);
        }
    }
    // `os.homedir()` env ladder exhausted (spec 02 §2.1 resolves env vars
    // first; the `home` crate is not a cma-manager dependency).
    PathBuf::new()
}

/// TS `VerifyCommandDeps` (log sinks live on [`CliOut`]).
#[allow(clippy::type_complexity)] // boxed DI seams mirror the TS deps object 1:1
pub struct VerifyCommandDeps {
    pub verify_paths_deps: VerifyPathsDeps,
    pub run_verify_flagged: Option<Box<dyn Fn(Vec<String>) -> BoxFuture<i32> + Send + Sync>>,
    pub set_storage_path: Option<SetStoragePathFn>,
}

impl Default for VerifyCommandDeps {
    fn default() -> Self {
        VerifyCommandDeps {
            verify_paths_deps: VerifyPathsDeps::default(),
            run_verify_flagged: Some(Box::new(|args| {
                Box::pin(async move {
                    let mut inner_out = CliOut::stdio();
                    crate::repair::verify_flagged::run_verify_flagged(&args, &mut inner_out).await
                })
            })),
            set_storage_path: Some(default_set_storage_path()),
        }
    }
}

/// TS `parseVerifyArgs(args)`.
pub fn parse_verify_args(args: &[String]) -> Result<VerifyCliOptions, String> {
    let mut options = VerifyCliOptions::default();
    let mut paths_explicit = false;
    let mut flagged_explicit = false;
    for arg in args {
        match arg.as_str() {
            "--json" | "-j" => options.json = true,
            "--paths" => {
                options.paths = true;
                paths_explicit = true;
            }
            "--flagged" => {
                options.flagged = true;
                flagged_explicit = true;
            }
            "--all" => {
                options.paths = true;
                options.flagged = true;
                options.all = true;
            }
            // Passed through to verify-flagged when --flagged or --all is
            // used.
            "--dry-run" | "-n" | "--no-restore" => {}
            other => return Err(format!("Unknown option: {other}")),
        }
    }
    if paths_explicit && flagged_explicit && !options.all {
        return Err(
            "--paths and --flagged cannot be combined; use --all to run both, or pick one"
                .to_string(),
        );
    }
    Ok(options)
}

/// TS `printVerifyUsage()`.
pub fn print_verify_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage:",
            "  codex-multi-auth verify --paths [--json]",
            "  codex-multi-auth verify --flagged [--json] [--dry-run] [--no-restore]",
            "",
            "Options:",
            "  --paths           Self-test storage path resolution chain and resolvePath sandbox",
            "  --flagged         Verify previously-flagged accounts (delegates to verify-flagged)",
            "  --json, -j        Print machine-readable JSON output",
            "",
            "Notes:",
            "  - `codex-multi-auth verify-flagged` remains available as a back-compat alias.",
            "  - `--paths` and `--flagged` cannot be combined; use `verify-flagged` when you only need flagged checks.",
        ]
        .join("\n"),
    );
}

fn normalize_for_compare(path: &Path) -> String {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let text = absolute.to_string_lossy().into_owned();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

fn is_within_base(base_dir: &Path, target_path: &str) -> bool {
    let base = normalize_for_compare(base_dir);
    let target = normalize_for_compare(Path::new(target_path));
    if target == base {
        return true;
    }
    let with_sep = if base.ends_with(std::path::MAIN_SEPARATOR) || base.ends_with('/') {
        base
    } else {
        format!("{base}{}", std::path::MAIN_SEPARATOR)
    };
    target.starts_with(&with_sep)
}

/// TS `pickEscapeProbePath(projectRoot)` — an absolute path guaranteed to be
/// outside home, tmp, and the project root; `None` when no safe candidate is
/// available (callers treat that as "skip the escape probe").
fn pick_escape_probe_path(deps: &VerifyPathsDeps, project_root: &Path) -> Option<String> {
    let tag = format!("codex_multi_auth_sandbox_escape_probe_{}", std::process::id());
    let candidates: Vec<String> = if cfg!(windows) {
        vec![
            format!("Z:\\__{tag}__"),
            format!("Y:\\__{tag}__"),
            format!("\\\\?\\UNC\\server-that-does-not-exist\\share\\{tag}"),
        ]
    } else {
        vec![
            format!("/__{tag}__"),
            format!("/var/__{tag}__"),
            format!("/opt/__{tag}__"),
        ]
    };

    let home = (deps.homedir)();
    let tmp = (deps.tmpdir)();
    candidates.into_iter().find(|candidate| {
        !is_within_base(&home, candidate)
            && !is_within_base(&tmp, candidate)
            && !is_within_base(project_root, candidate)
    })
}

fn run_sandbox_tests(deps: &VerifyPathsDeps) -> Vec<VerifySandboxResult> {
    let mut results = Vec::new();

    let inside_home = (deps.homedir)()
        .join(".codex")
        .join("multi-auth-verify-probe");
    let inside_home_text = inside_home.to_string_lossy().into_owned();
    match (deps.resolve_path)(&inside_home_text) {
        Ok(resolved) => results.push(VerifySandboxResult {
            name: "sandbox-accept-home".to_string(),
            input: inside_home_text,
            rejected: false,
            ok: !resolved.as_os_str().is_empty(),
            error: None,
        }),
        Err(error) => results.push(VerifySandboxResult {
            name: "sandbox-accept-home".to_string(),
            input: inside_home_text,
            rejected: true,
            ok: false,
            error: Some(error),
        }),
    }

    let inside_tmp = (deps.tmpdir)().join("codex-multi-auth-verify-probe.tmp");
    let inside_tmp_text = inside_tmp.to_string_lossy().into_owned();
    match (deps.resolve_path)(&inside_tmp_text) {
        Ok(resolved) => results.push(VerifySandboxResult {
            name: "sandbox-accept-tmp".to_string(),
            input: inside_tmp_text,
            rejected: false,
            ok: !resolved.as_os_str().is_empty(),
            error: None,
        }),
        Err(error) => results.push(VerifySandboxResult {
            name: "sandbox-accept-tmp".to_string(),
            input: inside_tmp_text,
            rejected: true,
            ok: false,
            error: Some(error),
        }),
    }

    let project_root = (deps.get_cwd)();
    let Some(escape_attempt) = pick_escape_probe_path(deps, &project_root) else {
        results.push(VerifySandboxResult {
            name: "sandbox-reject-escape".to_string(),
            input: String::new(),
            rejected: false,
            ok: true,
            error: Some(
                "skipped: no candidate outside home/tmp/project could be constructed".to_string(),
            ),
        });
        return results;
    };

    match (deps.resolve_path)(&escape_attempt) {
        Ok(_) => results.push(VerifySandboxResult {
            name: "sandbox-reject-escape".to_string(),
            input: escape_attempt,
            rejected: false,
            ok: false,
            error: Some("resolvePath accepted a sandbox-escape candidate".to_string()),
        }),
        Err(message) => {
            let looks_like_sandbox_rejection = message.to_lowercase().contains("access denied");
            results.push(VerifySandboxResult {
                name: "sandbox-reject-escape".to_string(),
                input: escape_attempt,
                rejected: true,
                ok: looks_like_sandbox_rejection,
                error: if looks_like_sandbox_rejection {
                    None
                } else {
                    Some(message)
                },
            });
        }
    }

    results
}

/// TS `runVerifyPathsCheck(deps)`.
pub fn run_verify_paths_check(deps: &VerifyPathsDeps) -> VerifyPathsReport {
    let mut steps: Vec<VerifyPathStep> = Vec::new();

    let cwd = (deps.get_cwd)();
    steps.push(VerifyPathStep {
        name: "process.cwd".to_string(),
        input: None,
        output: Some(cwd.to_string_lossy().into_owned()),
        ok: true,
        error: None,
    });

    let mut project_root: Option<PathBuf> = None;
    match (deps.find_project_root)(&cwd) {
        Some(result) => {
            project_root = Some(result.clone());
            steps.push(VerifyPathStep {
                name: "findProjectRoot".to_string(),
                input: Some(cwd.to_string_lossy().into_owned()),
                output: Some(result.to_string_lossy().into_owned()),
                ok: true,
                error: None,
            });
        }
        None => {
            steps.push(VerifyPathStep {
                name: "findProjectRoot".to_string(),
                input: Some(cwd.to_string_lossy().into_owned()),
                output: None,
                ok: false,
                error: Some("no project root detected from cwd".to_string()),
            });
        }
    }

    let mut identity_root: Option<PathBuf> = None;
    if let Some(project_root) = &project_root {
        let output = (deps.resolve_project_storage_identity_root)(project_root);
        identity_root = Some(output.clone());
        steps.push(VerifyPathStep {
            name: "resolveProjectStorageIdentityRoot".to_string(),
            input: Some(project_root.to_string_lossy().into_owned()),
            output: Some(output.to_string_lossy().into_owned()),
            ok: true,
            error: None,
        });
    }

    let key_input = identity_root.clone().or(project_root.clone());
    let mut storage_key: Option<String> = None;
    if let Some(key_input) = &key_input {
        let output = (deps.get_project_storage_key)(key_input);
        storage_key = Some(output.clone());
        steps.push(VerifyPathStep {
            name: "getProjectStorageKey".to_string(),
            input: Some(key_input.to_string_lossy().into_owned()),
            output: Some(output),
            ok: true,
            error: None,
        });
        steps.push(VerifyPathStep {
            name: "getProjectConfigDir".to_string(),
            input: Some(key_input.to_string_lossy().into_owned()),
            output: Some(
                (deps.get_project_config_dir)(key_input)
                    .to_string_lossy()
                    .into_owned(),
            ),
            ok: true,
            error: None,
        });
        steps.push(VerifyPathStep {
            name: "getProjectGlobalConfigDir".to_string(),
            input: Some(key_input.to_string_lossy().into_owned()),
            output: Some(
                (deps.get_project_global_config_dir)(key_input)
                    .to_string_lossy()
                    .into_owned(),
            ),
            ok: true,
            error: None,
        });
    }

    let sandbox_tests = run_sandbox_tests(deps);
    let ok = steps.iter().all(|step| step.ok)
        && sandbox_tests.iter().all(|test| test.ok)
        && storage_key.as_deref().is_some_and(|key| !key.is_empty());

    VerifyPathsReport {
        ok,
        steps,
        sandbox_tests,
    }
}

fn step_to_value(step: &VerifyPathStep) -> Value {
    let mut row = Map::new();
    row.insert("name".into(), Value::from(step.name.clone()));
    if let Some(input) = &step.input {
        row.insert("input".into(), Value::from(input.clone()));
    }
    if let Some(output) = &step.output {
        row.insert("output".into(), Value::from(output.clone()));
    }
    row.insert("ok".into(), Value::from(step.ok));
    if let Some(error) = &step.error {
        row.insert("error".into(), Value::from(error.clone()));
    }
    Value::Object(row)
}

fn sandbox_to_value(test: &VerifySandboxResult) -> Value {
    let mut row = Map::new();
    row.insert("name".into(), Value::from(test.name.clone()));
    row.insert("input".into(), Value::from(test.input.clone()));
    row.insert("rejected".into(), Value::from(test.rejected));
    row.insert("ok".into(), Value::from(test.ok));
    if let Some(error) = &test.error {
        row.insert("error".into(), Value::from(error.clone()));
    }
    Value::Object(row)
}

fn paths_report_to_value(report: &VerifyPathsReport) -> Value {
    let mut payload = Map::new();
    payload.insert("command".into(), Value::from("verify"));
    payload.insert("mode".into(), Value::from("paths"));
    payload.insert("ok".into(), Value::from(report.ok));
    payload.insert(
        "steps".into(),
        Value::Array(report.steps.iter().map(step_to_value).collect()),
    );
    payload.insert(
        "sandboxTests".into(),
        Value::Array(report.sandbox_tests.iter().map(sandbox_to_value).collect()),
    );
    Value::Object(payload)
}

/// Production entry.
pub async fn run_verify_command(args: &[String], out: &mut CliOut) -> i32 {
    run_verify_command_with(args, &VerifyCommandDeps::default(), out).await
}

/// TS `runVerifyCommand(args, deps)`.
pub async fn run_verify_command_with(
    args: &[String],
    deps: &VerifyCommandDeps,
    out: &mut CliOut,
) -> i32 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_verify_usage(out);
        return 0;
    }

    let options = match parse_verify_args(args) {
        Ok(options) => options,
        Err(message) => {
            out.error(message);
            print_verify_usage(out);
            return 1;
        }
    };

    if !options.paths && !options.flagged {
        out.error(
            "verify requires a mode: --paths (path chain self-test), --flagged (verify flagged accounts), or --all",
        );
        print_verify_usage(out);
        return 1;
    }

    let mut paths_report: Option<VerifyPathsReport> = None;
    if options.paths {
        // Reset storage-path state so the sandbox probe and path-chain steps
        // run against a clean baseline, matching the other command handlers.
        if let Some(set_storage_path) = &deps.set_storage_path {
            set_storage_path(None);
        }
        paths_report = Some(run_verify_paths_check(&deps.verify_paths_deps));
    }

    let mut flagged_exit_code: Option<i32> = None;
    if options.flagged {
        let Some(run_verify_flagged) = &deps.run_verify_flagged else {
            out.error("verify --flagged delegation is not available");
            return 1;
        };
        let passthrough: Vec<String> = args
            .iter()
            .filter(|arg| *arg != "--flagged" && *arg != "--paths" && *arg != "--all")
            .cloned()
            .collect();
        flagged_exit_code = Some(run_verify_flagged(passthrough).await);
    }

    let paths_ok = paths_report.as_ref().map(|report| report.ok).unwrap_or(true);
    let flagged_ok = flagged_exit_code.is_none_or(|code| code == 0);
    let overall_ok = paths_ok && flagged_ok;

    if options.json {
        let mut payload = Map::new();
        payload.insert("command".into(), Value::from("verify"));
        payload.insert(
            "mode".into(),
            Value::from(if options.all {
                "all"
            } else if options.paths {
                "paths"
            } else {
                "flagged"
            }),
        );
        payload.insert("ok".into(), Value::from(overall_ok));
        if let Some(report) = &paths_report {
            payload.insert("paths".into(), paths_report_to_value(report));
        }
        if let Some(code) = flagged_exit_code {
            payload.insert("flaggedExitCode".into(), Value::from(code));
        }
        out.info(cma_core::json_io::stringify_pretty2(&Value::Object(payload)));
        return if overall_ok { 0 } else { 1 };
    }

    let Some(report) = &paths_report else {
        return if overall_ok { 0 } else { 1 };
    };

    out.info(format!(
        "verify --paths: {}",
        if report.ok { "OK" } else { "FAIL" }
    ));
    out.info("");
    out.info("Path chain:");
    for step in &report.steps {
        let marker = if step.ok { "✓" } else { "✗" };
        let details = if step.ok {
            format!(" → {}", step.output.as_deref().unwrap_or(""))
        } else {
            format!(" error: {}", step.error.as_deref().unwrap_or("unknown"))
        };
        let input = step
            .input
            .as_ref()
            .map(|input| format!(" (in: {input})"))
            .unwrap_or_default();
        out.info(format!("  {marker} {}{input}{details}", step.name));
    }
    out.info("");
    out.info("Sandbox tests:");
    for test in &report.sandbox_tests {
        let marker = if test.ok { "✓" } else { "✗" };
        let rejected_label = if test.rejected { "rejected" } else { "accepted" };
        out.info(format!(
            "  {marker} {} ({rejected_label}): {}",
            test.name,
            test.error.as_deref().unwrap_or("ok")
        ));
    }

    if overall_ok { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    fn fake_paths_deps(reject_message: &'static str) -> VerifyPathsDeps {
        VerifyPathsDeps {
            get_cwd: Box::new(|| PathBuf::from("/repo/project")),
            find_project_root: Box::new(|_| Some(PathBuf::from("/repo/project"))),
            resolve_project_storage_identity_root: Box::new(|root| root.to_path_buf()),
            get_project_storage_key: Box::new(|_| "project-abc123456789".to_string()),
            get_project_config_dir: Box::new(|root| root.join(".codex")),
            get_project_global_config_dir: Box::new(|_| PathBuf::from("/home/u/.codex/multi-auth/projects/project-abc123456789")),
            resolve_path: Box::new(move |input| {
                // Accept anything under home/tmp probes; reject the escape
                // candidates with the injected message.
                if input.contains("sandbox_escape_probe") {
                    Err(reject_message.to_string())
                } else {
                    Ok(PathBuf::from(input))
                }
            }),
            homedir: Box::new(|| PathBuf::from("/home/u")),
            tmpdir: Box::new(|| PathBuf::from("/tmp")),
        }
    }

    fn deps_with(paths: VerifyPathsDeps, flagged_code: Option<i32>) -> VerifyCommandDeps {
        VerifyCommandDeps {
            verify_paths_deps: paths,
            run_verify_flagged: flagged_code.map(|code| {
                let f: Box<dyn Fn(Vec<String>) -> BoxFuture<i32> + Send + Sync> =
                    Box::new(move |_args| Box::pin(async move { code }));
                f
            }),
            set_storage_path: None,
        }
    }

    #[tokio::test]
    async fn requires_a_mode() {
        let deps = deps_with(fake_paths_deps("Access denied: nope"), Some(0));
        let mut out = CliOut::capture();
        assert_eq!(run_verify_command_with(&[], &deps, &mut out).await, 1);
        assert_eq!(
            out.error_text(),
            "verify requires a mode: --paths (path chain self-test), --flagged (verify flagged accounts), or --all"
        );
    }

    #[tokio::test]
    async fn paths_and_flagged_cannot_be_combined_without_all() {
        let deps = deps_with(fake_paths_deps("Access denied: nope"), Some(0));
        let mut out = CliOut::capture();
        assert_eq!(
            run_verify_command_with(&args(&["--paths", "--flagged"]), &deps, &mut out).await,
            1
        );
        assert_eq!(
            out.error_text(),
            "--paths and --flagged cannot be combined; use --all to run both, or pick one"
        );
    }

    #[tokio::test]
    async fn paths_mode_reports_ok_chain_and_access_denied_rejection() {
        let deps = deps_with(fake_paths_deps("Access denied: path must be within home directory, project directory, or temp directory"), None);
        let mut out = CliOut::capture();
        assert_eq!(
            run_verify_command_with(&args(&["--paths", "--json"]), &deps, &mut out).await,
            0
        );
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["command"], Value::from("verify"));
        assert_eq!(payload["mode"], Value::from("paths"));
        assert_eq!(payload["ok"], Value::from(true));
        let steps = payload["paths"]["steps"].as_array().expect("steps");
        let names: Vec<&str> = steps
            .iter()
            .map(|step| step["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            vec![
                "process.cwd",
                "findProjectRoot",
                "resolveProjectStorageIdentityRoot",
                "getProjectStorageKey",
                "getProjectConfigDir",
                "getProjectGlobalConfigDir",
            ]
        );
        let sandbox = payload["paths"]["sandboxTests"].as_array().expect("tests");
        assert_eq!(sandbox.len(), 3);
        assert_eq!(sandbox[2]["name"], Value::from("sandbox-reject-escape"));
        assert_eq!(sandbox[2]["rejected"], Value::from(true));
        assert_eq!(sandbox[2]["ok"], Value::from(true));
        assert!(sandbox[2].get("error").is_none());
    }

    #[tokio::test]
    async fn wrong_rejection_reason_fails_the_escape_probe() {
        let deps = deps_with(fake_paths_deps("ENOENT: no such file"), None);
        let mut out = CliOut::capture();
        assert_eq!(
            run_verify_command_with(&args(&["--paths"]), &deps, &mut out).await,
            1
        );
        let text = out.info_text();
        assert!(text.starts_with("verify --paths: FAIL"));
        assert!(text.contains("✗ sandbox-reject-escape (rejected): ENOENT: no such file"));
    }

    #[tokio::test]
    async fn no_project_root_fails_and_reports_error() {
        let mut paths = fake_paths_deps("Access denied: x");
        paths.find_project_root = Box::new(|_| None);
        let deps = deps_with(paths, None);
        let mut out = CliOut::capture();
        assert_eq!(run_verify_command_with(&args(&["--paths"]), &deps, &mut out).await, 1);
        let text = out.info_text();
        assert!(text.contains("✗ findProjectRoot (in: "));
        assert!(text.contains(" error: no project root detected from cwd"));
    }

    #[tokio::test]
    async fn flagged_mode_delegates_and_passes_through_flags() {
        use std::sync::{Arc, Mutex};
        let received: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let received_clone = Arc::clone(&received);
        let deps = VerifyCommandDeps {
            verify_paths_deps: fake_paths_deps("Access denied: x"),
            run_verify_flagged: Some(Box::new(move |args| {
                received_clone.lock().unwrap().push(args);
                Box::pin(async { 0 })
            })),
            set_storage_path: None,
        };
        let mut out = CliOut::capture();
        assert_eq!(
            run_verify_command_with(
                &args(&["--flagged", "--json", "--dry-run", "-n", "--no-restore"]),
                &deps,
                &mut out
            )
            .await,
            0
        );
        assert_eq!(
            received.lock().unwrap()[0],
            args(&["--json", "--dry-run", "-n", "--no-restore"])
        );
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["mode"], Value::from("flagged"));
        assert_eq!(payload["flaggedExitCode"], Value::from(0));
        assert!(payload.get("paths").is_none());
    }

    #[tokio::test]
    async fn all_mode_combines_both_and_flagged_failure_fails_overall() {
        let deps = deps_with(fake_paths_deps("Access denied: x"), Some(1));
        let mut out = CliOut::capture();
        assert_eq!(
            run_verify_command_with(&args(&["--all", "--json"]), &deps, &mut out).await,
            1
        );
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["mode"], Value::from("all"));
        assert_eq!(payload["ok"], Value::from(false));
        assert_eq!(payload["flaggedExitCode"], Value::from(1));
    }

    #[tokio::test]
    async fn flagged_delegation_unavailable_errors() {
        let deps = deps_with(fake_paths_deps("Access denied: x"), None);
        let mut out = CliOut::capture();
        assert_eq!(
            run_verify_command_with(&args(&["--flagged"]), &deps, &mut out).await,
            1
        );
        assert_eq!(out.error_text(), "verify --flagged delegation is not available");
    }
}
