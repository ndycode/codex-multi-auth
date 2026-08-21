//! Port of `lib/auth/callback-guidance.ts` — operator-facing guidance for
//! OAuth callback failures on the fixed callback port (spec 07 §7).
//!
//! The redirect URI is registered with the provider, so the port cannot be
//! negotiated away when it is contended. The best the CLI can do is name the
//! likely conflict and point at a flow that does not need the port at all.
//!
//! Windows and WSL contend for that port as far as a browser running on the
//! Windows host is concerned, so a listener on either side can swallow a
//! callback intended for the other. From inside the distro this is invisible:
//! the WSL listener binds cleanly and simply never receives the redirect.
//!
//! Contention is only *asserted* when it was actually observed — that is, the
//! listen failed with `EADDRINUSE`. A callback that never arrives is far more
//! often a cancelled or abandoned sign-in than a stolen redirect, so that case
//! is phrased as a conditional rather than a diagnosis (spec 07 gotcha 7).
//! All user-visible strings below are FROZEN copies of the TS texts.

use cma_core::wsl::{get_wsl_distro_name, is_wsl};

use crate::oauth::AUTH_REDIRECT;

/// Why the browser callback did not produce an authorization code.
///
/// - `BindFailed`: the local listener could not take the callback port at all.
/// - `CallbackTimeout`: the listener bound, but no redirect ever arrived.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CallbackFailureReason {
    BindFailed,
    CallbackTimeout,
}

impl CallbackFailureReason {
    /// The TS string literal for this reason.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BindFailed => "bind-failed",
            Self::CallbackTimeout => "callback-timeout",
        }
    }
}

/// Extra detail from the failed bind, when available (TS
/// `CallbackFailureContext`, `@internal`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallbackFailureContext {
    /// `errno` code from a failed listen, when one is known.
    pub bind_error_code: Option<String>,
}

const USE_DEVICE_AUTH: &str =
    "  Or sign in without the callback port: codex-multi-auth login --device-auth";

fn inspect_windows() -> String {
    format!(
        "  Windows (PowerShell):  Get-NetTCPConnection -LocalPort {}",
        AUTH_REDIRECT.port
    )
}

fn inspect_linux() -> String {
    format!(
        "  Linux / WSL:           ss -lptn 'sport = :{}'",
        AUTH_REDIRECT.port
    )
}

fn inspect_darwin() -> String {
    format!(
        "  macOS:                 lsof -nP -iTCP:{} -sTCP:LISTEN",
        AUTH_REDIRECT.port
    )
}

/// Platform seam (TS reads `process.platform`; Rust compiles the current
/// platform in but keeps the decision table injectable for tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostPlatform {
    Win32,
    Darwin,
    Linux,
}

fn current_platform() -> HostPlatform {
    if cfg!(windows) {
        HostPlatform::Win32
    } else if cfg!(target_os = "macos") {
        HostPlatform::Darwin
    } else {
        HostPlatform::Linux
    }
}

/// WSL context seam (`isWsl()` / `getWslDistroName()`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct WslContext {
    is_wsl: bool,
    distro: Option<String>,
}

fn current_wsl_context() -> WslContext {
    let inside = is_wsl();
    WslContext {
        is_wsl: inside,
        distro: if inside { get_wsl_distro_name() } else { None },
    }
}

/// The commands that would reveal a listener on the callback port here.
///
/// Inside WSL both sides of the boundary are worth checking, because the
/// offending listener is usually the one on the Windows host.
fn inspect_commands(platform: HostPlatform, wsl: &WslContext) -> Vec<String> {
    if wsl.is_wsl {
        return vec![inspect_windows(), inspect_linux()];
    }
    match platform {
        HostPlatform::Win32 => vec![inspect_windows()],
        HostPlatform::Darwin => vec![inspect_darwin()],
        HostPlatform::Linux => vec![inspect_linux()],
    }
}

/// Why a listener on the other side of the Windows/WSL boundary may be at
/// fault. Empty when no WSL boundary is in play.
fn cross_boundary_note(platform: HostPlatform, wsl: &WslContext) -> Vec<String> {
    if wsl.is_wsl {
        let where_label = match &wsl.distro {
            Some(distro) => format!("WSL ({distro})"),
            None => "WSL".to_string(),
        };
        return vec![
            format!(
                "You are running inside {where_label}, but the browser opens on the Windows host."
            ),
            format!(
                "Windows and {where_label} contend for localhost:{}, so a codex-multi-auth",
                AUTH_REDIRECT.port
            ),
            "or Codex login or proxy on the Windows side can take the callback meant for this one."
                .to_string(),
        ];
    }
    if platform == HostPlatform::Win32 {
        return vec![format!(
            "A codex-multi-auth login or proxy running inside WSL can also hold port {}.",
            AUTH_REDIRECT.port
        )];
    }
    Vec::new()
}

fn describe_callback_failure_on(
    reason: CallbackFailureReason,
    context: &CallbackFailureContext,
    platform: HostPlatform,
    wsl: &WslContext,
) -> Vec<String> {
    let port = AUTH_REDIRECT.port;

    if reason == CallbackFailureReason::BindFailed {
        // A failed listen is hard evidence: something is on the port right now.
        if context.bind_error_code.as_deref() == Some("EADDRINUSE") {
            let mut lines = vec![format!(
                "Could not listen on port {port} for the OAuth callback — another process already holds it."
            )];
            lines.extend(cross_boundary_note(platform, wsl));
            lines.push(String::new());
            lines.push("Find the listener:".to_string());
            lines.extend(inspect_commands(platform, wsl));
            lines.push(String::new());
            lines.push("Close it, then retry.".to_string());
            lines.push(USE_DEVICE_AUTH.to_string());
            return lines;
        }

        let code_suffix = match &context.bind_error_code {
            Some(code) => format!(" ({code})"),
            None => String::new(),
        };
        return vec![
            format!("Could not listen on port {port} for the OAuth callback{code_suffix}."),
            String::new(),
            "The callback port is fixed by the provider and cannot be changed.".to_string(),
            USE_DEVICE_AUTH.to_string(),
        ];
    }

    // The listener bound cleanly and nothing arrived. Usually the sign-in was
    // simply cancelled or abandoned — say so first, and do not misdiagnose it.
    let mut lines = vec![
        format!("No OAuth callback arrived on port {port} before the sign-in window closed."),
        String::new(),
        "If you closed or cancelled the browser sign-in, just run login again.".to_string(),
        String::new(),
        "If you completed sign-in in the browser and still landed here, something else".to_string(),
        format!("may have taken the callback on port {port}:"),
    ];
    lines.extend(cross_boundary_note(platform, wsl));
    lines.extend(inspect_commands(platform, wsl));
    lines.push(String::new());
    lines.push(USE_DEVICE_AUTH.to_string());
    lines
}

/// Build the lines shown to the user when a browser OAuth callback fails
/// (TS `describeCallbackFailure`). Empty strings are intentional blank
/// separators.
pub fn describe_callback_failure(
    reason: CallbackFailureReason,
    context: &CallbackFailureContext,
) -> Vec<String> {
    describe_callback_failure_on(reason, context, current_platform(), &current_wsl_context())
}

// ===========================================================================
// Tests (ported from test/callback-guidance.test.ts — the TS suite mocks
// process.platform and lib/wsl; here the injected decision-table core is
// exercised directly)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn native(platform: HostPlatform) -> WslContext {
        let _ = platform;
        WslContext::default()
    }

    fn wsl(distro: Option<&str>) -> WslContext {
        WslContext {
            is_wsl: true,
            distro: distro.map(String::from),
        }
    }

    fn as_text(lines: &[String]) -> String {
        lines.join("\n")
    }

    fn describe(
        reason: CallbackFailureReason,
        context: &CallbackFailureContext,
        platform: HostPlatform,
        wsl_ctx: &WslContext,
    ) -> String {
        as_text(&describe_callback_failure_on(
            reason, context, platform, wsl_ctx,
        ))
    }

    #[test]
    fn always_offers_the_device_code_flow() {
        for reason in [
            CallbackFailureReason::BindFailed,
            CallbackFailureReason::CallbackTimeout,
        ] {
            let text = describe(
                reason,
                &CallbackFailureContext::default(),
                HostPlatform::Linux,
                &native(HostPlatform::Linux),
            );
            assert!(text.contains("--device-auth"), "{reason:?} lacks device auth");
        }
    }

    #[test]
    fn asserts_contention_on_eaddrinuse_hard_evidence() {
        let text = describe(
            CallbackFailureReason::BindFailed,
            &CallbackFailureContext {
                bind_error_code: Some("EADDRINUSE".to_string()),
            },
            HostPlatform::Linux,
            &native(HostPlatform::Linux),
        );
        assert!(text.contains("another process already holds it"));
        assert!(text.contains(&format!("port {}", AUTH_REDIRECT.port)));
    }

    #[test]
    fn does_not_claim_contention_for_unrelated_bind_errors() {
        let text = describe(
            CallbackFailureReason::BindFailed,
            &CallbackFailureContext {
                bind_error_code: Some("EACCES".to_string()),
            },
            HostPlatform::Linux,
            &native(HostPlatform::Linux),
        );
        assert!(text.contains("EACCES"));
        assert!(!text.contains("already holds it"));
        assert!(!text.contains("ss -lptn"));
        assert!(text.contains("The callback port is fixed by the provider and cannot be changed."));
    }

    #[test]
    fn bind_failed_without_code_omits_the_parenthetical() {
        let lines = describe_callback_failure_on(
            CallbackFailureReason::BindFailed,
            &CallbackFailureContext::default(),
            HostPlatform::Linux,
            &native(HostPlatform::Linux),
        );
        assert_eq!(
            lines[0],
            format!(
                "Could not listen on port {} for the OAuth callback.",
                AUTH_REDIRECT.port
            )
        );
    }

    #[test]
    fn does_not_diagnose_a_cancelled_sign_in_as_port_contention() {
        let text = describe(
            CallbackFailureReason::CallbackTimeout,
            &CallbackFailureContext::default(),
            HostPlatform::Linux,
            &native(HostPlatform::Linux),
        );
        assert!(text.contains("If you closed or cancelled the browser sign-in"));
        assert!(!text.contains("another process already holds it"));
        // The contention explanation is offered conditionally, not asserted.
        assert!(text.contains("If you completed sign-in in the browser"));
    }

    #[test]
    fn gives_macos_lsof_never_the_linux_only_ss() {
        let text = describe(
            CallbackFailureReason::CallbackTimeout,
            &CallbackFailureContext::default(),
            HostPlatform::Darwin,
            &native(HostPlatform::Darwin),
        );
        assert!(text.contains("lsof -nP -iTCP:1455"));
        assert!(!text.contains("ss -lptn"));
        assert!(!text.contains("Get-NetTCPConnection"));
    }

    #[test]
    fn gives_native_linux_ss_and_no_wsl_narrative() {
        let text = describe(
            CallbackFailureReason::CallbackTimeout,
            &CallbackFailureContext::default(),
            HostPlatform::Linux,
            &native(HostPlatform::Linux),
        );
        assert!(text.contains("ss -lptn"));
        assert!(!text.contains("Get-NetTCPConnection"));
        // The `ss` line is labelled "Linux / WSL", so assert the absence of
        // the explanatory narrative rather than of the substring "WSL".
        assert!(!text.contains("the browser opens on the Windows host"));
        assert!(!text.contains("can also hold port"));
    }

    #[test]
    fn tells_a_windows_host_that_a_wsl_listener_can_also_hold_the_port() {
        let text = describe(
            CallbackFailureReason::BindFailed,
            &CallbackFailureContext {
                bind_error_code: Some("EADDRINUSE".to_string()),
            },
            HostPlatform::Win32,
            &native(HostPlatform::Win32),
        );
        assert!(text.contains("Get-NetTCPConnection"));
        assert!(text.contains("inside WSL can also hold port"));
        assert!(!text.contains("lsof"));
    }

    #[test]
    fn inside_wsl_explains_the_split_and_offers_both_inspection_commands() {
        let text = describe(
            CallbackFailureReason::CallbackTimeout,
            &CallbackFailureContext::default(),
            HostPlatform::Linux,
            &wsl(Some("Debian")),
        );
        assert!(text.contains("WSL (Debian)"));
        assert!(text.contains("the browser opens on the Windows host"));
        // The offending listener is usually on the other side of the
        // boundary, so both sides are worth checking.
        assert!(text.contains("Get-NetTCPConnection"));
        assert!(text.contains("ss -lptn"));
    }

    #[test]
    fn still_explains_the_split_when_the_distro_name_is_unknown() {
        let text = describe(
            CallbackFailureReason::CallbackTimeout,
            &CallbackFailureContext::default(),
            HostPlatform::Linux,
            &wsl(None),
        );
        assert!(text.contains("WSL"));
        assert!(!text.contains("WSL ()"));
    }

    #[test]
    fn reason_string_literals_match_the_ts_union() {
        assert_eq!(CallbackFailureReason::BindFailed.as_str(), "bind-failed");
        assert_eq!(
            CallbackFailureReason::CallbackTimeout.as_str(),
            "callback-timeout"
        );
    }

    #[test]
    fn public_entry_uses_the_current_platform_without_panicking() {
        // Smoke: the env-reading wrapper produces a non-empty guidance block
        // ending in the device-auth escape hatch on every platform.
        let lines = describe_callback_failure(
            CallbackFailureReason::CallbackTimeout,
            &CallbackFailureContext::default(),
        );
        assert!(!lines.is_empty());
        assert_eq!(lines.last().map(String::as_str), Some(USE_DEVICE_AUTH));
    }
}
