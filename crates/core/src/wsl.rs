//! Port of `lib/wsl.ts` — WSL (Windows Subsystem for Linux) detection.
//!
//! Behavior source: specs/01-foundation.md §2.14, §5.3.
//!
//! WSL reports itself as Linux, so every platform switch in this package
//! treats it as a native Linux host. That is wrong for anything crossing the
//! Windows boundary: the default browser, the clipboard, and the loopback
//! interface that receives the OAuth callback all belong to the Windows host
//! rather than to the distro.
//!
//! Contracts:
//! - False unless the platform is Linux.
//! - True when `WSL_DISTRO_NAME` or `WSL_INTEROP` is non-empty (NOT trimmed —
//!   the TS check is `.length > 0` on the raw value).
//! - Fallback for env-stripping shells (systemd units, cron): `/proc/version`
//!   content matching `/microsoft|wsl/i`; read failure → false.
//! - The result is memoized (it cannot change within a process lifetime).
//! - `get_wsl_distro_name` returns the TRIMMED `WSL_DISTRO_NAME` when inside
//!   WSL and non-empty, else `None`.

use std::sync::Mutex;

static CACHED_IS_WSL: Mutex<Option<bool>> = Mutex::new(None);

/// Pure detection core (env values + `/proc/version` reader injected) so the
/// decision table is unit-testable on every platform. The platform gate lives
/// in [`detect_wsl`].
fn detect_wsl_from(
    wsl_distro_name: Option<&str>,
    wsl_interop: Option<&str>,
    read_proc_version: impl FnOnce() -> Option<String>,
) -> bool {
    // Set by WSL itself; present in every interop-enabled distro shell.
    // Raw (untrimmed) length check, matching the TS source.
    if !wsl_distro_name.unwrap_or("").is_empty() || !wsl_interop.unwrap_or("").is_empty() {
        return true;
    }

    // /proc/version probe for shells that strip the environment.
    match read_proc_version() {
        Some(content) => {
            let lower = content.to_lowercase();
            lower.contains("microsoft") || lower.contains("wsl")
        }
        None => false,
    }
}

fn detect_wsl() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    let distro = std::env::var("WSL_DISTRO_NAME").ok();
    let interop = std::env::var("WSL_INTEROP").ok();
    detect_wsl_from(distro.as_deref(), interop.as_deref(), || {
        std::fs::read_to_string("/proc/version").ok()
    })
}

/// Whether the current process is running inside WSL.
///
/// The result is cached because it cannot change within a process lifetime.
pub fn is_wsl() -> bool {
    let mut cached = CACHED_IS_WSL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(value) = *cached {
        return value;
    }
    let value = detect_wsl();
    *cached = Some(value);
    value
}

/// The WSL distro name (for example `Debian`), when WSL exposes it.
///
/// Returns `None` outside WSL or when unset/empty after trimming.
pub fn get_wsl_distro_name() -> Option<String> {
    if !is_wsl() {
        return None;
    }
    let name = std::env::var("WSL_DISTRO_NAME").unwrap_or_default();
    let trimmed = name.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Clear the memoized [`is_wsl`] result.
///
/// Test seam — production code must not call this.
#[doc(hidden)]
pub fn reset_wsl_detection_cache_for_tests() {
    let mut cached = CACHED_IS_WSL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cached = None;
}

// ---------------------------------------------------------------------------
// Tests (ported from test/wsl.test.ts decision table; the platform-gated
// public functions are exercised where the platform allows)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn env_variables_win_over_proc_version() {
        assert!(detect_wsl_from(Some("Ubuntu"), None, || None));
        assert!(detect_wsl_from(None, Some("/run/WSL/8_interop"), || None));
        // Untrimmed length check: whitespace-only counts as set (TS parity).
        assert!(detect_wsl_from(Some(" "), None, || None));
    }

    #[test]
    fn falls_back_to_proc_version_matching() {
        assert!(detect_wsl_from(None, None, || Some(
            "Linux version 5.15.90.1-microsoft-standard-WSL2".to_string()
        )));
        assert!(detect_wsl_from(None, None, || Some(
            "Linux version 6.6.0-WSL2-custom".to_string()
        )));
        assert!(!detect_wsl_from(None, None, || Some(
            "Linux version 6.1.0-13-amd64 (debian-kernel@lists.debian.org)".to_string()
        )));
    }

    #[test]
    fn proc_version_read_failure_means_not_wsl() {
        assert!(!detect_wsl_from(None, None, || None));
    }

    #[test]
    fn empty_env_values_do_not_trigger_detection() {
        assert!(!detect_wsl_from(Some(""), Some(""), || None));
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    #[serial(wsl)]
    fn is_wsl_is_false_on_non_linux_platforms_and_memoizes() {
        reset_wsl_detection_cache_for_tests();
        assert!(!is_wsl());
        // Second call served from the cache.
        assert!(!is_wsl());
        assert_eq!(get_wsl_distro_name(), None);
        reset_wsl_detection_cache_for_tests();
    }

    #[test]
    #[serial(wsl)]
    fn reset_seam_clears_the_memoized_value() {
        reset_wsl_detection_cache_for_tests();
        let first = is_wsl();
        reset_wsl_detection_cache_for_tests();
        let second = is_wsl();
        assert_eq!(first, second);
        reset_wsl_detection_cache_for_tests();
    }
}
