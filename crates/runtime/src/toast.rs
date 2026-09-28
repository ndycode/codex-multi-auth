//! Port of `lib/runtime/toast.ts` — `showRuntimeToast`.
//!
//! The TS implementation forwarded toasts to the JS host's TUI
//! (`client.tui.showToast`), swallowing every error. The Rust CLI has no host
//! UI (ARCHITECTURE §3: "toasts become stderr notices via
//! `cma-runtime/src/toast.rs`"), so a toast becomes a one-line stderr notice.
//! To keep long-running processes (proxy/router) from spamming stderr with
//! repeated notices, identical messages are debounced: a message that was
//! already shown within the last 60 seconds is suppressed (rate-limit
//! debounce, ARCHITECTURE §6.12). Errors writing to stderr are ignored,
//! matching the TS "ignore when TUI is not available" contract.

use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use cma_core::constants::PLUGIN_NAME;

/// Toast variants (TS union `"info" | "success" | "warning" | "error"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ToastVariant {
    Info,
    #[default]
    Success,
    Warning,
    Error,
}

impl ToastVariant {
    pub fn as_str(self) -> &'static str {
        match self {
            ToastVariant::Info => "info",
            ToastVariant::Success => "success",
            ToastVariant::Warning => "warning",
            ToastVariant::Error => "error",
        }
    }
}

/// Optional toast options (TS `{ title?, duration? }`). `duration` has no
/// stderr equivalent and is accepted for signature parity only.
#[derive(Debug, Clone, Default)]
pub struct ToastOptions {
    pub title: Option<String>,
    pub duration: Option<u64>,
}

/// Identical-message debounce window.
const TOAST_DEBOUNCE_MS: u64 = 60_000;

/// Message → last-emitted instant. Capped opportunistically: expired entries
/// are pruned on every emit, so the map only grows with concurrently-live
/// distinct messages.
static TOAST_HISTORY: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

/// Test capture sink: when armed, emitted toasts are recorded here (and NOT
/// written to stderr). The identical-message debounce still applies first,
/// so captures reflect exactly what a user would have seen.
static TOAST_CAPTURE: Mutex<Option<Vec<(String, String)>>> = Mutex::new(None);

/// Show a runtime toast as a stderr notice.
///
/// Returns `true` when the notice was emitted, `false` when it was suppressed
/// by the 60 s identical-message debounce. All I/O errors are swallowed.
pub fn show_runtime_toast(message: &str, variant: ToastVariant) -> bool {
    show_runtime_toast_with(message, variant, &ToastOptions::default())
}

/// [`show_runtime_toast`] with options. `title`, when present and non-empty,
/// is prefixed onto the notice (`title: message`); `duration` is ignored.
pub fn show_runtime_toast_with(
    message: &str,
    variant: ToastVariant,
    options: &ToastOptions,
) -> bool {
    let body = match options.title.as_deref() {
        // TS spreads `...(options?.title && { title })` — only truthy titles.
        Some(title) if !title.is_empty() => format!("{title}: {message}"),
        _ => message.to_string(),
    };
    let key = format!("{}\u{0}{}", variant.as_str(), body);
    let now = Instant::now();
    {
        let mut guard = TOAST_HISTORY
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let history = guard.get_or_insert_with(HashMap::new);
        let window = Duration::from_millis(TOAST_DEBOUNCE_MS);
        if let Some(last) = history.get(&key)
            && now.duration_since(*last) < window
        {
            return false;
        }
        history.retain(|_, last| now.duration_since(*last) < window);
        history.insert(key, now);
    }
    {
        let mut capture = TOAST_CAPTURE
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(captured) = capture.as_mut() {
            captured.push((variant.as_str().to_string(), body));
            return true;
        }
    }
    let line = match variant {
        ToastVariant::Success => format!("[{PLUGIN_NAME}] {body}"),
        _ => format!("[{PLUGIN_NAME}] {}: {body}", variant.as_str()),
    };
    // Swallow write errors (TS swallowed every showToast failure).
    let _ = writeln!(std::io::stderr(), "{line}");
    true
}

/// Test hook: arm the capture sink (also clears the debounce history so the
/// capture starts from a clean slate).
pub fn start_toast_capture_for_tests() {
    reset_toast_debounce_for_tests();
    let mut capture = TOAST_CAPTURE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *capture = Some(Vec::new());
}

/// Test hook: disarm the capture sink and return the `(variant, message)`
/// pairs emitted while it was armed.
pub fn take_captured_toasts_for_tests() -> Vec<(String, String)> {
    let mut capture = TOAST_CAPTURE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    capture.take().unwrap_or_default()
}

/// Test hook: clear the debounce history so tests observe fresh behavior.
pub fn reset_toast_debounce_for_tests() {
    let mut guard = TOAST_HISTORY
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *guard = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    #[serial(toast)]
    fn emits_then_debounces_identical_messages() {
        reset_toast_debounce_for_tests();
        assert!(show_runtime_toast("Switched to account 2", ToastVariant::Info));
        // Identical message+variant within the window: suppressed.
        assert!(!show_runtime_toast("Switched to account 2", ToastVariant::Info));
        // Different message: emitted.
        assert!(show_runtime_toast("Switched to account 3", ToastVariant::Info));
        // Different variant of the same message: distinct key, emitted.
        assert!(show_runtime_toast("Switched to account 2", ToastVariant::Warning));
        reset_toast_debounce_for_tests();
    }

    #[test]
    #[serial(toast)]
    fn title_is_folded_into_the_debounce_key() {
        reset_toast_debounce_for_tests();
        let with_title = ToastOptions {
            title: Some("Update".to_string()),
            duration: None,
        };
        assert!(show_runtime_toast_with("ready", ToastVariant::Success, &with_title));
        assert!(!show_runtime_toast_with("ready", ToastVariant::Success, &with_title));
        // Bare message is a different key.
        assert!(show_runtime_toast("ready", ToastVariant::Success));
        reset_toast_debounce_for_tests();
    }

    #[test]
    #[serial(toast)]
    fn empty_title_is_ignored_like_ts_falsy_title() {
        reset_toast_debounce_for_tests();
        let empty_title = ToastOptions {
            title: Some(String::new()),
            duration: None,
        };
        assert!(show_runtime_toast_with("msg", ToastVariant::Error, &empty_title));
        // Same key as a bare message → debounced.
        assert!(!show_runtime_toast("msg", ToastVariant::Error));
        reset_toast_debounce_for_tests();
    }

    #[test]
    fn variant_strings_are_frozen() {
        assert_eq!(ToastVariant::Info.as_str(), "info");
        assert_eq!(ToastVariant::Success.as_str(), "success");
        assert_eq!(ToastVariant::Warning.as_str(), "warning");
        assert_eq!(ToastVariant::Error.as_str(), "error");
        assert_eq!(ToastVariant::default(), ToastVariant::Success);
    }
}
