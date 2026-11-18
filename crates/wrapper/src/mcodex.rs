//! Port of `scripts/mcodex.js` — the convenience launcher over the codex
//! wrapper. Modes (spec 14 §2.1):
//! - default: forward every arg to the sibling codex wrapper binary;
//! - `--monitor`: `watch -n <interval> codex-multi-auth list` (interval
//!   default 5 s via `MCODEX_MONITOR_INTERVAL`, positive number only; exits 1
//!   with an install hint when `watch` is missing);
//! - `--tmux`/`-t` (+ optional `--live-accounts` immediately after): tmux
//!   session (default name `mcodex` via `MCODEX_TMUX_SESSION`; history limit
//!   default 50000 via `MCODEX_TMUX_HISTORY_LIMIT`); warns and forwards
//!   without tmux when tmux is missing (R8: shell out, no TUI).
//!
//! Deviation vs TS: the bash/node launcher spawned `node <sibling codex.js>`;
//! the Rust port spawns the sibling `codex-multi-auth-codex` binary (same
//! no-PATH-shim guarantee).

use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::bin_resolver::split_path_entries;
use crate::statusline::resolve_sibling_cma_binary;

pub const DEFAULT_MONITOR_INTERVAL: &str = "5";
pub const DEFAULT_TMUX_HISTORY_LIMIT: &str = "50000";
pub const DEFAULT_TMUX_SESSION: &str = "mcodex";

/// TS `parseMcodexArgs(argv)` mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McodexMode {
    Forward,
    Monitor,
    Tmux,
}

/// TS `parseMcodexArgs(argv)` result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMcodexArgs {
    pub mode: McodexMode,
    pub live_accounts: bool,
    pub forward_args: Vec<String>,
}

/// TS `parseMcodexArgs(argv)` — the FIRST argument selects the mode; only
/// `--tmux`/`-t` consumes a following `--live-accounts`.
pub fn parse_mcodex_args(argv: &[String]) -> ParsedMcodexArgs {
    let first = argv.first().map(String::as_str).unwrap_or("");
    if first == "--monitor" {
        return ParsedMcodexArgs {
            mode: McodexMode::Monitor,
            live_accounts: false,
            forward_args: argv[1..].to_vec(),
        };
    }
    if first == "--tmux" || first == "-t" {
        let mut rest = argv[1..].to_vec();
        let mut live_accounts = false;
        if rest.first().map(String::as_str) == Some("--live-accounts") {
            live_accounts = true;
            rest.remove(0);
        }
        return ParsedMcodexArgs {
            mode: McodexMode::Tmux,
            live_accounts,
            forward_args: rest,
        };
    }
    ParsedMcodexArgs {
        mode: McodexMode::Forward,
        live_accounts: false,
        forward_args: argv.to_vec(),
    }
}

fn is_positive_number(value: &str) -> bool {
    // /^[0-9]+(\.[0-9]+)?$/
    let mut parts = value.split('.');
    let int_part = parts.next().unwrap_or("");
    let frac_part = parts.next();
    if parts.next().is_some() {
        return false;
    }
    if int_part.is_empty() || !int_part.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    match frac_part {
        None => true,
        Some(frac) => !frac.is_empty() && frac.chars().all(|c| c.is_ascii_digit()),
    }
}

fn is_plain_integer(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_digit())
}

fn coerce_validated_setting(
    raw_value: Option<&str>,
    validate: impl Fn(&str) -> bool,
    fallback: &str,
    env_name: &str,
    warn: &mut dyn FnMut(&str),
) -> String {
    // Mirror bash `${VAR:-default}`: unset OR empty falls back silently; any
    // other value is validated and, if it fails, replaced with a warning.
    let value = match raw_value {
        None | Some("") => fallback,
        Some(other) => other,
    };
    if !validate(value) {
        warn(&format!("mcodex: invalid {env_name} '{value}'; using {fallback}"));
        return fallback.to_string();
    }
    value.to_string()
}

/// TS `resolveMonitorInterval(env, warn)`.
pub fn resolve_monitor_interval(
    raw: Option<&str>,
    warn: &mut dyn FnMut(&str),
) -> String {
    coerce_validated_setting(
        raw,
        is_positive_number,
        DEFAULT_MONITOR_INTERVAL,
        "MCODEX_MONITOR_INTERVAL",
        warn,
    )
}

/// TS `resolveTmuxHistoryLimit(env, warn)`.
pub fn resolve_tmux_history_limit(
    raw: Option<&str>,
    warn: &mut dyn FnMut(&str),
) -> String {
    coerce_validated_setting(
        raw,
        is_plain_integer,
        DEFAULT_TMUX_HISTORY_LIMIT,
        "MCODEX_TMUX_HISTORY_LIMIT",
        warn,
    )
}

/// TS `resolveTmuxSession(env)`.
pub fn resolve_tmux_session(raw: Option<&str>) -> String {
    let configured = raw.unwrap_or("").trim();
    if configured.is_empty() {
        DEFAULT_TMUX_SESSION.to_string()
    } else {
        configured.to_string()
    }
}

/// TS `resolvePosixToolOnPath(tool, env, platform)`.
pub fn resolve_posix_tool_on_path(tool: &str, path_value: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{tool}.exe"), format!("{tool}.cmd"), tool.to_string()]
    } else {
        vec![tool.to_string()]
    };
    for entry in split_path_entries(path_value) {
        for name in &names {
            let candidate = Path::new(&entry).join(name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn path_env_value() -> String {
    std::env::var("PATH")
        .or_else(|_| std::env::var("Path"))
        .unwrap_or_default()
}

fn has_posix_tool(tool: &str) -> bool {
    resolve_posix_tool_on_path(tool, &path_env_value()).is_some()
}

/// TS `buildWatchArgs(interval)` — argv tokens, never a shell string.
pub fn build_watch_args(interval: &str) -> Vec<String> {
    vec![
        "-n".to_string(),
        interval.to_string(),
        "codex-multi-auth".to_string(),
        "list".to_string(),
    ]
}

const WATCH_MISSING_MESSAGE: &str = "mcodex: 'watch' is not installed; the live account monitor requires it (install procps / procps-ng).";

fn exit_code_of(status: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            // SIGINT → 130 (TS parity); any other signal → 1.
            return if signal == 2 { 130 } else { 1 };
        }
    }
    status.code().unwrap_or(1)
}

async fn spawn_and_wait_inherit(program: &Path, args: &[String], label: &str) -> i32 {
    let mut command = tokio::process::Command::new(program);
    command.args(args);
    match command.spawn() {
        Ok(mut child) => match child.wait().await {
            Ok(status) => exit_code_of(status),
            Err(_) => 1,
        },
        Err(error) => {
            eprintln!("mcodex: failed to launch {label}: {error}");
            1
        }
    }
}

async fn forward_to_codex_wrapper(forward_args: &[String]) -> i32 {
    let wrapper = resolve_sibling_cma_binary("codex-multi-auth-codex");
    spawn_and_wait_inherit(&wrapper, forward_args, "codex wrapper").await
}

async fn run_monitor(interval: &str) -> i32 {
    let Some(watch_path) = resolve_posix_tool_on_path("watch", &path_env_value()) else {
        eprintln!("{WATCH_MISSING_MESSAGE}");
        return 1;
    };
    spawn_and_wait_inherit(&watch_path, &build_watch_args(interval), "watch").await
}

/// Run a tmux subcommand synchronously, swallowing output (TS `runTmux`).
fn run_tmux(tmux_path: &Path, args: &[String]) -> Option<std::process::ExitStatus> {
    std::process::Command::new(tmux_path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()
}

fn tmux_args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

fn configure_tmux_scrollback(tmux_path: &Path, history_limit: &str, target: Option<&str>) {
    let target_args: Vec<String> = match target {
        Some(t) => vec!["-t".to_string(), t.to_string()],
        None => Vec::new(),
    };
    let mut set_mouse = tmux_args(&["set-option"]);
    set_mouse.extend(target_args.clone());
    set_mouse.extend(tmux_args(&["mouse", "on"]));
    run_tmux(tmux_path, &set_mouse);
    let mut set_history = tmux_args(&["set-option"]);
    set_history.extend(target_args);
    set_history.extend(vec!["history-limit".to_string(), history_limit.to_string()]);
    run_tmux(tmux_path, &set_history);
    run_tmux(tmux_path, &tmux_args(&["bind-key", "-T", "root", "WheelUpPane", "copy-mode", "-e"]));
    run_tmux(
        tmux_path,
        &tmux_args(&["bind-key", "-T", "copy-mode", "WheelUpPane", "send-keys", "-X", "scroll-up"]),
    );
    run_tmux(
        tmux_path,
        &tmux_args(&["bind-key", "-T", "copy-mode", "WheelDownPane", "send-keys", "-X", "scroll-down"]),
    );
    run_tmux(
        tmux_path,
        &tmux_args(&["bind-key", "-T", "copy-mode-vi", "WheelUpPane", "send-keys", "-X", "scroll-up"]),
    );
    run_tmux(
        tmux_path,
        &tmux_args(&["bind-key", "-T", "copy-mode-vi", "WheelDownPane", "send-keys", "-X", "scroll-down"]),
    );
}

/// TS `formatTmuxSessionSuffix(date)` — `HHMMSS` local-ish suffix. The Rust
/// port derives it from the epoch clock (uniqueness is what matters).
pub fn format_tmux_session_suffix(now_ms: i64) -> String {
    let seconds_of_day = now_ms.div_euclid(1000).rem_euclid(86_400);
    let hours = seconds_of_day / 3600;
    let minutes = (seconds_of_day % 3600) / 60;
    let seconds = seconds_of_day % 60;
    format!("{hours:02}{minutes:02}{seconds:02}")
}

struct TmuxModeOptions {
    live_accounts: bool,
    forward_args: Vec<String>,
    interval: String,
    history_limit: String,
    session: String,
}

async fn run_tmux_mode(options: TmuxModeOptions) -> i32 {
    let TmuxModeOptions {
        live_accounts,
        forward_args,
        interval,
        history_limit,
        session,
    } = options;

    let Some(tmux_path) = resolve_posix_tool_on_path("tmux", &path_env_value()) else {
        // Degrade exactly like the bash version: warn, then forward without tmux.
        eprintln!("mcodex: tmux is not installed; launching without tmux");
        return forward_to_codex_wrapper(&forward_args).await;
    };

    let watch_available = live_accounts && has_posix_tool("watch");
    if live_accounts && !watch_available {
        eprintln!("{WATCH_MISSING_MESSAGE}");
    }

    // Already inside a tmux client: configure the current session, optionally
    // add a live-accounts pane, then run codex in the current pane.
    if !std::env::var("TMUX").unwrap_or_default().is_empty() {
        configure_tmux_scrollback(&tmux_path, &history_limit, None);
        if watch_available {
            let mut split = tmux_args(&["split-window", "-h", "watch"]);
            split.extend(build_watch_args(&interval));
            run_tmux(&tmux_path, &split);
        }
        return forward_to_codex_wrapper(&forward_args).await;
    }

    // Not inside tmux: fresh detached session, configure, optional live pane,
    // attach, propagate the exit code.
    let mut target_session = session;
    let has_session = run_tmux(
        &tmux_path,
        &tmux_args(&["has-session", "-t", &target_session]),
    )
    .is_some_and(|status| status.success());
    if has_session {
        target_session = format!(
            "{target_session}-{}",
            format_tmux_session_suffix(cma_core::utils::now_ms())
        );
    }
    let wrapper = resolve_sibling_cma_binary("codex-multi-auth-codex");
    let mut new_session = tmux_args(&["new-session", "-d", "-s", &target_session, "-n", "codex"]);
    new_session.push(wrapper.display().to_string());
    new_session.extend(forward_args.iter().cloned());
    run_tmux(&tmux_path, &new_session);
    configure_tmux_scrollback(&tmux_path, &history_limit, Some(&target_session));
    if watch_available {
        let mut split = tmux_args(&[
            "split-window",
            "-h",
            "-t",
            &format!("{target_session}:0"),
            "watch",
        ]);
        split.extend(build_watch_args(&interval));
        run_tmux(&tmux_path, &split);
    }
    run_tmux(
        &tmux_path,
        &tmux_args(&["select-pane", "-t", &format!("{target_session}:0.0")]),
    );
    let mut attach = tokio::process::Command::new(&tmux_path);
    attach.args(["attach-session", "-t", &target_session]);
    match attach.spawn() {
        Ok(mut child) => match child.wait().await {
            Ok(status) => {
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    if status.signal() == Some(2) {
                        return 130;
                    }
                }
                status.code().unwrap_or(0)
            }
            Err(_) => 0,
        },
        Err(error) => {
            eprintln!("mcodex: failed to attach tmux session: {error}");
            1
        }
    }
}

/// TS `runMcodex(argv, env, platform)` — entrypoint for the `mcodex` bin.
/// Returns the process exit code.
pub async fn run_mcodex(argv: &[String]) -> i32 {
    let parsed = parse_mcodex_args(argv);
    let mut warn = |message: &str| eprintln!("{message}");
    let interval_env = std::env::var("MCODEX_MONITOR_INTERVAL").ok();
    let interval = resolve_monitor_interval(interval_env.as_deref(), &mut warn);
    let history_env = std::env::var("MCODEX_TMUX_HISTORY_LIMIT").ok();
    let history_limit = resolve_tmux_history_limit(history_env.as_deref(), &mut warn);

    match parsed.mode {
        McodexMode::Monitor => run_monitor(&interval).await,
        McodexMode::Tmux => {
            let session_env = std::env::var("MCODEX_TMUX_SESSION").ok();
            run_tmux_mode(TmuxModeOptions {
                live_accounts: parsed.live_accounts,
                forward_args: parsed.forward_args,
                interval,
                history_limit,
                session: resolve_tmux_session(session_env.as_deref()),
            })
            .await
        }
        McodexMode::Forward => forward_to_codex_wrapper(&parsed.forward_args).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_modes() {
        let parsed = parse_mcodex_args(&v(&["--monitor", "extra"]));
        assert_eq!(parsed.mode, McodexMode::Monitor);
        assert!(!parsed.live_accounts);
        assert_eq!(parsed.forward_args, v(&["extra"]));

        let parsed = parse_mcodex_args(&v(&["--tmux", "--live-accounts", "exec"]));
        assert_eq!(parsed.mode, McodexMode::Tmux);
        assert!(parsed.live_accounts);
        assert_eq!(parsed.forward_args, v(&["exec"]));

        let parsed = parse_mcodex_args(&v(&["-t", "exec"]));
        assert_eq!(parsed.mode, McodexMode::Tmux);
        assert!(!parsed.live_accounts);
        assert_eq!(parsed.forward_args, v(&["exec"]));

        // --live-accounts is only consumed right after --tmux/-t.
        let parsed = parse_mcodex_args(&v(&["-t", "exec", "--live-accounts"]));
        assert!(!parsed.live_accounts);
        assert_eq!(parsed.forward_args, v(&["exec", "--live-accounts"]));

        // Anything else forwards untouched (including a later --monitor).
        let parsed = parse_mcodex_args(&v(&["exec", "--monitor"]));
        assert_eq!(parsed.mode, McodexMode::Forward);
        assert_eq!(parsed.forward_args, v(&["exec", "--monitor"]));

        let parsed = parse_mcodex_args(&[]);
        assert_eq!(parsed.mode, McodexMode::Forward);
        assert!(parsed.forward_args.is_empty());
    }

    #[test]
    fn monitor_interval_validation() {
        let warnings = std::cell::RefCell::new(Vec::<String>::new());
        let mut warn = |m: &str| warnings.borrow_mut().push(m.to_string());
        assert_eq!(resolve_monitor_interval(None, &mut warn), "5");
        assert_eq!(resolve_monitor_interval(Some(""), &mut warn), "5");
        assert_eq!(resolve_monitor_interval(Some("2.5"), &mut warn), "2.5");
        assert_eq!(resolve_monitor_interval(Some("10"), &mut warn), "10");
        assert!(warnings.borrow().is_empty());
        assert_eq!(resolve_monitor_interval(Some("2; rm -rf /"), &mut warn), "5");
        assert_eq!(
            *warnings.borrow(),
            vec!["mcodex: invalid MCODEX_MONITOR_INTERVAL '2; rm -rf /'; using 5"]
        );
        assert_eq!(resolve_monitor_interval(Some("-1"), &mut warn), "5");
        assert_eq!(resolve_monitor_interval(Some("1."), &mut warn), "5");
    }

    #[test]
    fn tmux_history_limit_validation() {
        let warnings = std::cell::RefCell::new(Vec::<String>::new());
        let mut warn = |m: &str| warnings.borrow_mut().push(m.to_string());
        assert_eq!(resolve_tmux_history_limit(None, &mut warn), "50000");
        assert_eq!(resolve_tmux_history_limit(Some("123"), &mut warn), "123");
        assert_eq!(resolve_tmux_history_limit(Some("1.5"), &mut warn), "50000");
        assert_eq!(
            *warnings.borrow(),
            vec!["mcodex: invalid MCODEX_TMUX_HISTORY_LIMIT '1.5'; using 50000"]
        );
    }

    #[test]
    fn tmux_session_resolution() {
        assert_eq!(resolve_tmux_session(None), "mcodex");
        assert_eq!(resolve_tmux_session(Some("  ")), "mcodex");
        assert_eq!(resolve_tmux_session(Some(" my-sess ")), "my-sess");
    }

    #[test]
    fn watch_args_are_discrete_tokens() {
        assert_eq!(
            build_watch_args("2.5"),
            v(&["-n", "2.5", "codex-multi-auth", "list"])
        );
    }

    #[test]
    fn session_suffix_is_hhmmss() {
        // 18:10:42 UTC
        let ms = ((18 * 3600 + 10 * 60 + 42) * 1000) as i64;
        assert_eq!(format_tmux_session_suffix(ms), "181042");
        assert_eq!(format_tmux_session_suffix(ms + 86_400_000), "181042");
    }

    #[test]
    fn posix_tool_resolution_on_synthetic_path() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("tools");
        std::fs::create_dir_all(&dir).unwrap();
        let name = if cfg!(windows) { "watch.exe" } else { "watch" };
        std::fs::write(dir.join(name), "x").unwrap();
        let found = resolve_posix_tool_on_path("watch", dir.to_str().unwrap()).unwrap();
        assert_eq!(found, dir.join(name));
        assert!(resolve_posix_tool_on_path("tmux", dir.to_str().unwrap()).is_none());
        assert!(resolve_posix_tool_on_path("watch", "").is_none());
    }
}
