//! Port of `lib/auth/browser.ts` — best-effort cross-platform browser open +
//! clipboard copy, including WSL interop (spec 07 §6).
//!
//! Key contracts (spec 07 gotchas 9–10):
//! - `CODEX_AUTH_NO_BROWSER` non-empty decides ALONE — `CODEX_AUTH_NO_BROWSER=0`
//!   explicitly re-enables launching even with `BROWSER=none`.
//! - Windows goes through `powershell.exe -NoLogo -NoProfile -Command` (never
//!   `cmd start`, which breaks on `&`/`:` in URLs) with backtick/`$`/`"`
//!   escaping.
//! - WSL prefers `wslview` (wslu → Windows default browser), then PowerShell
//!   interop, then falls through to the Linux opener (an in-distro X/Wayland
//!   browser is possible). Clipboard: `clip.exe` → PowerShell → Linux tools.
//! - All spawns are fire-and-forget; spawn/stdin errors are swallowed. The
//!   return value means "a launch was ATTEMPTED", not "it worked".
//! - Callers must redact sensitive tokens from `url`/`text` beforehand;
//!   nothing here logs or redacts.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use cma_core::constants::PLATFORM_OPENERS;
use cma_core::wsl::is_wsl;

/// `$BROWSER` values that disable launching (TS `BROWSER_DISABLED_VALUES`).
const BROWSER_DISABLED_VALUES: [&str; 5] = ["0", "false", "no", "off", "none"];
/// `$CODEX_AUTH_NO_BROWSER` values that suppress launching
/// (TS `NO_BROWSER_TRUTHY_VALUES`).
const NO_BROWSER_TRUTHY_VALUES: [&str; 4] = ["1", "true", "yes", "on"];

/// Gets the platform-specific command to open a URL in the default browser
/// (TS `getBrowserOpener`).
pub fn get_browser_opener() -> &'static str {
    if cfg!(target_os = "macos") {
        PLATFORM_OPENERS.darwin
    } else if cfg!(windows) {
        PLATFORM_OPENERS.win32
    } else {
        PLATFORM_OPENERS.linux
    }
}

/// Whether browser launching is suppressed by the environment
/// (TS `isBrowserLaunchSuppressed`).
pub fn is_browser_launch_suppressed() -> bool {
    let no_browser = std::env::var("CODEX_AUTH_NO_BROWSER").ok();
    let browser = std::env::var("BROWSER").ok();
    is_browser_launch_suppressed_from(no_browser.as_deref(), browser.as_deref())
}

/// Pure decision core for [`is_browser_launch_suppressed`] (injected env
/// values — the TS tests mutate `process.env`; Rust tests inject).
fn is_browser_launch_suppressed_from(no_browser: Option<&str>, browser: Option<&str>) -> bool {
    let explicit_no_browser = no_browser.unwrap_or("").trim().to_lowercase();
    if !explicit_no_browser.is_empty() {
        // Non-empty, it alone decides — `0`/`false` explicitly UN-suppress.
        return NO_BROWSER_TRUTHY_VALUES.contains(&explicit_no_browser.as_str());
    }

    let browser_setting = browser.unwrap_or("").trim().to_lowercase();
    BROWSER_DISABLED_VALUES.contains(&browser_setting.as_str())
}

/// Whether the trailing path component of `command` carries an extension
/// (TS regex `/\.[^\\/]+$/`).
fn has_extension(command: &str) -> bool {
    match command.rfind('.') {
        Some(index) => {
            let suffix = &command[index + 1..];
            !suffix.is_empty() && !suffix.contains('/') && !suffix.contains('\\')
        }
        None => false,
    }
}

/// Determines whether a given command name exists on the system PATH
/// (TS `commandExists`). Windows resolves via PATHEXT (default
/// `.EXE;.CMD;.BAT;.COM`); POSIX requires a regular file with ≥1 exec bit.
fn command_exists(command: &str) -> bool {
    if command.is_empty() {
        return false;
    }

    // Unreachable from openBrowserUrl on win32 (PowerShell is used instead),
    // kept for parity: `start` is a cmd builtin, not a PATH entry.
    if cfg!(windows) && command.eq_ignore_ascii_case("start") {
        return true;
    }

    let path_value = std::env::var("PATH").unwrap_or_default();
    let delimiter = if cfg!(windows) { ';' } else { ':' };
    let entries: Vec<&str> = path_value
        .split(delimiter)
        .filter(|entry| !entry.is_empty())
        .collect();
    if entries.is_empty() {
        return false;
    }

    if cfg!(windows) {
        let pathext = std::env::var("PATHEXT").unwrap_or_default();
        let pathext = if pathext.is_empty() {
            ".EXE;.CMD;.BAT;.COM".to_string()
        } else {
            pathext
        };
        let exts: Vec<&str> = pathext.split(';').filter(|ext| !ext.is_empty()).collect();
        let direct = has_extension(command);
        for entry in entries {
            if direct {
                if Path::new(entry).join(command).exists() {
                    return true;
                }
                continue;
            }
            for ext in &exts {
                if Path::new(entry).join(format!("{command}{ext}")).exists() {
                    return true;
                }
            }
        }
        return false;
    }

    for entry in entries {
        let candidate = Path::new(entry).join(command);
        let Ok(metadata) = std::fs::metadata(&candidate) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        // On POSIX, ensure at least one executable bit is set.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                continue;
            }
        }
        return true;
    }
    false
}

/// Escape a value for safe interpolation into a double-quoted PowerShell
/// string: neutralizes backticks, `$` sub-expression injection, and embedded
/// double quotes (TS `escapeForPowerShell` — same replacement ORDER).
fn escape_for_powershell(value: &str) -> String {
    value
        .replace('`', "``")
        .replace('$', "`$")
        .replace('"', "\"\"")
}

/// Spawn a child fire-and-forget: stdout/stderr discarded, optional text
/// piped to stdin, all errors (spawn, EPIPE on a dead child's stdin)
/// swallowed. Returns once the spawn was ATTEMPTED — mirroring the TS
/// contract where `spawn()` errors surface asynchronously and are ignored.
fn spawn_fire_and_forget(program: &str, args: &[&str], stdin_text: Option<&str>) -> bool {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(if stdin_text.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    match command.spawn() {
        Ok(mut child) => {
            if let Some(text) = stdin_text
                && let Some(mut stdin) = child.stdin.take()
            {
                // A child that dies before draining stdin yields EPIPE
                // here — swallowed, matching the TS stdin error handler.
                let _ = stdin.write_all(text.as_bytes());
            }
            // Detach: reap in a background thread so no zombie lingers
            // (Node's libuv reaps automatically; std Rust does not).
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            true
        }
        // TS parity: spawn failures are emitted async and swallowed; the
        // launch still counts as attempted.
        Err(_) => true,
    }
}

/// Run a PowerShell command, fire-and-forget (TS `spawnPowerShell`).
/// Reachable from Windows and from WSL, where `powershell.exe` resolves
/// through Windows/Linux PATH interop. Returns `false` when PowerShell is
/// unavailable.
fn spawn_powershell(command: &str, stdin_text: Option<&str>) -> bool {
    if !command_exists("powershell.exe") {
        return false;
    }
    spawn_fire_and_forget(
        "powershell.exe",
        &["-NoLogo", "-NoProfile", "-Command", command],
        stdin_text,
    )
}

/// Launch the user's default browser on `url` using a platform-appropriate
/// command (TS `openBrowserUrl`). Best-effort fire-and-forget; returns
/// whether a launch was *attempted*. Callers must redact sensitive tokens
/// from `url` before calling.
pub fn open_browser_url(url: &str) -> bool {
    if is_browser_launch_suppressed() {
        return false;
    }

    // Windows: PowerShell Start-Process avoids cmd/start quirks with URLs
    // containing '&' or ':'.
    if cfg!(windows) {
        return spawn_powershell(
            &format!("Start-Process \"{}\"", escape_for_powershell(url)),
            None,
        );
    }

    if is_wsl() {
        // wslu's browser shim: hands the URL to the Windows default browser.
        if command_exists("wslview") {
            return spawn_fire_and_forget("wslview", &[url], None);
        }
        if spawn_powershell(
            &format!("Start-Process \"{}\"", escape_for_powershell(url)),
            None,
        ) {
            return true;
        }
        // Fall through: an X/Wayland browser inside the distro is possible.
    }

    let opener = get_browser_opener();
    if !command_exists(opener) {
        return false;
    }
    spawn_fire_and_forget(opener, &[url], None)
}

/// Copy `text` into the system clipboard using a best-effort platform command
/// (TS `copyTextToClipboard`). Clipboard contents are not redacted or logged
/// — callers must mask sensitive tokens beforehand. Returns whether a
/// clipboard command was launched.
pub fn copy_text_to_clipboard(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }

    if cfg!(windows) {
        return spawn_powershell(
            &format!("Set-Clipboard -Value \"{}\"", escape_for_powershell(text)),
            None,
        );
    }

    if is_wsl() {
        // The clipboard the user pastes from is the Windows one, not the
        // distro's.
        if command_exists("clip.exe") {
            return spawn_fire_and_forget("clip.exe", &[], Some(text));
        }
        if spawn_powershell(
            &format!("Set-Clipboard -Value \"{}\"", escape_for_powershell(text)),
            None,
        ) {
            return true;
        }
        // Fall through to the Linux clipboard tools.
    }

    if cfg!(target_os = "macos") {
        if !command_exists("pbcopy") {
            return false;
        }
        return spawn_fire_and_forget("pbcopy", &[], Some(text));
    }

    let linux_clipboard_commands: [(&str, &[&str]); 3] = [
        ("wl-copy", &[]),
        ("xclip", &["-selection", "clipboard"]),
        ("xsel", &["--clipboard", "--input"]),
    ];
    for (command, args) in linux_clipboard_commands {
        if !command_exists(command) {
            continue;
        }
        return spawn_fire_and_forget(command, args, Some(text));
    }
    false
}

// ===========================================================================
// Tests (ported from test/browser.test.ts — the TS suite mocks
// process.platform/child_process/fs; here the pure cores (suppression table,
// PowerShell escaping, PATH probing) carry the assertions, plus env-driven
// suppression through EnvSandbox)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    // ----- suppression decision table ---------------------------------------

    #[test]
    fn no_browser_truthy_values_suppress() {
        for value in ["1", "true", "yes", "on", " TRUE ", "Yes"] {
            assert!(
                is_browser_launch_suppressed_from(Some(value), None),
                "{value:?} should suppress"
            );
        }
    }

    #[test]
    fn no_browser_false_like_values_opt_in() {
        for value in ["0", "false", "no", "off", "whatever"] {
            assert!(
                !is_browser_launch_suppressed_from(Some(value), None),
                "{value:?} should not suppress"
            );
        }
    }

    #[test]
    fn explicit_false_like_no_browser_overrides_disabling_browser_value() {
        // CODEX_AUTH_NO_BROWSER=0 / false re-enable launching even with
        // BROWSER=none (spec 07 gotcha 9).
        assert!(!is_browser_launch_suppressed_from(Some("0"), Some("none")));
        assert!(!is_browser_launch_suppressed_from(
            Some("false"),
            Some("none")
        ));
    }

    #[test]
    fn browser_disabled_values_suppress_when_no_browser_unset() {
        for value in ["0", "false", "no", "off", "none", " None "] {
            assert!(
                is_browser_launch_suppressed_from(None, Some(value)),
                "BROWSER={value:?} should suppress"
            );
        }
        assert!(!is_browser_launch_suppressed_from(None, Some("firefox")));
        assert!(!is_browser_launch_suppressed_from(None, None));
        // Empty CODEX_AUTH_NO_BROWSER does not decide; BROWSER still applies.
        assert!(is_browser_launch_suppressed_from(Some("  "), Some("none")));
    }

    #[test]
    fn truthy_no_browser_keeps_suppression_even_with_disabled_browser() {
        assert!(is_browser_launch_suppressed_from(Some("true"), Some("none")));
    }

    // ----- PowerShell escaping ----------------------------------------------

    #[test]
    fn escapes_powershell_metacharacters() {
        // From test/browser.test.ts "escapes PowerShell metacharacters".
        assert_eq!(
            format!(
                "Start-Process \"{}\"",
                escape_for_powershell("https://example.com/?a=$x&b=`y\"z")
            ),
            "Start-Process \"https://example.com/?a=`$x&b=``y\"\"z\""
        );
        assert_eq!(escape_for_powershell("https://example.com/$var"), "https://example.com/`$var");
        assert_eq!(escape_for_powershell("hello$world"), "hello`$world");
    }

    // ----- has_extension (the /\.[^\\/]+$/ test) ----------------------------

    #[test]
    fn extension_detection_matches_the_ts_regex() {
        assert!(has_extension("powershell.exe"));
        assert!(has_extension("foo.bar.cmd"));
        assert!(!has_extension("cmd"));
        assert!(!has_extension("dir.name/cmd"));
        assert!(!has_extension("dir.name\\cmd"));
        assert!(!has_extension("trailing."));
    }

    // ----- platform opener --------------------------------------------------

    #[test]
    fn returns_platform_opener_command() {
        let expected = if cfg!(target_os = "macos") {
            PLATFORM_OPENERS.darwin
        } else if cfg!(windows) {
            PLATFORM_OPENERS.win32
        } else {
            PLATFORM_OPENERS.linux
        };
        assert_eq!(get_browser_opener(), expected);
    }

    // ----- command_exists ---------------------------------------------------

    #[test]
    fn command_exists_rejects_empty_and_nonexistent_commands() {
        assert!(!command_exists(""));
        assert!(!command_exists("definitely-not-a-real-command-xyz-123"));
    }

    #[cfg(windows)]
    #[test]
    fn command_exists_treats_start_as_builtin_on_windows() {
        assert!(command_exists("start"));
        assert!(command_exists("START"));
    }

    #[cfg(windows)]
    #[test]
    fn command_exists_finds_powershell_on_windows_path() {
        // powershell.exe ships with every supported Windows.
        assert!(command_exists("powershell.exe"));
        // PATHEXT resolution: the bare name resolves too.
        assert!(command_exists("powershell"));
    }

    #[test]
    #[serial(env)]
    fn command_exists_is_false_with_empty_path() {
        let mut sandbox = EnvSandbox::new();
        sandbox.set_var("PATH", "");
        assert!(!command_exists("xdg-open"));
        assert!(!command_exists("wslview"));
    }

    // ----- open/copy env-driven suppression ---------------------------------

    #[test]
    #[serial(env)]
    fn open_browser_url_returns_false_when_suppressed_by_environment() {
        let mut sandbox = EnvSandbox::new();
        sandbox.set_var("CODEX_AUTH_NO_BROWSER", "1");
        assert!(is_browser_launch_suppressed());
        assert!(!open_browser_url("https://example.com"));
    }

    #[test]
    #[serial(env)]
    fn browser_none_suppresses_launch() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("CODEX_AUTH_NO_BROWSER");
        sandbox.set_var("BROWSER", "none");
        assert!(is_browser_launch_suppressed());
        assert!(!open_browser_url("https://example.com"));
    }

    #[test]
    #[serial(env)]
    fn truthy_no_browser_beats_disabled_browser_in_env() {
        let mut sandbox = EnvSandbox::new();
        sandbox.set_var("CODEX_AUTH_NO_BROWSER", "true");
        sandbox.set_var("BROWSER", "none");
        assert!(is_browser_launch_suppressed());
        assert!(!open_browser_url("https://example.com"));
    }

    #[test]
    #[serial(env)]
    fn explicit_zero_unsuppresses_but_launch_needs_an_opener() {
        let mut sandbox = EnvSandbox::new();
        sandbox.set_var("CODEX_AUTH_NO_BROWSER", "0");
        sandbox.set_var("BROWSER", "none");
        assert!(!is_browser_launch_suppressed());
        // With an empty PATH no opener resolves, so no launch is attempted —
        // exercising the not-suppressed → opener-missing path without ever
        // opening a real browser from the test suite.
        sandbox.set_var("PATH", "");
        assert!(!open_browser_url("https://example.com"));
    }

    #[test]
    fn copy_text_to_clipboard_returns_false_for_empty_text() {
        assert!(!copy_text_to_clipboard(""));
    }

    #[test]
    #[serial(env)]
    fn copy_text_to_clipboard_returns_false_when_no_tool_resolves() {
        let mut sandbox = EnvSandbox::new();
        sandbox.set_var("PATH", "");
        // With an empty PATH neither powershell.exe (win32), pbcopy (darwin),
        // nor the Linux tools resolve → no spawn, false.
        assert!(!copy_text_to_clipboard("hello"));
    }
}
