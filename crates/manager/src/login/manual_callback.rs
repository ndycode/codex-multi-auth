//! Port of `lib/codex-manager/manual-callback.ts` — pure classification of a
//! manually pasted OAuth callback.
//!
//! Splitting `invalid` and `state-mismatch` out from `cancelled` is the fix
//! for the issue #512 follow-up: a malformed or wrong-attempt callback URL
//! must NOT print `Cancelled.` and hide the real validation error.

use cma_auth::oauth::parse_authorization_input;

/// `ManualCallbackClassification`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ManualCallbackClassification {
    Code { code: String },
    Cancelled,
    Invalid,
    StateMismatch,
}

const CANCEL_KEYWORDS: [&str; 5] = ["", "q", "quit", "cancel", "back"];
const ESC_CHARACTER: char = '\u{001b}';

/// `classifyManualCallbackInput(answer, expectedState)` — pure and I/O-free.
///
/// `answer` is `None` when the input stream closed before any line was read
/// (treated as a cancellation).
pub fn classify_manual_callback_input(
    answer: Option<&str>,
    expected_state: &str,
) -> ManualCallbackClassification {
    let Some(answer) = answer else {
        return ManualCallbackClassification::Cancelled;
    };
    if answer.contains(ESC_CHARACTER) {
        return ManualCallbackClassification::Cancelled;
    }
    let normalized = answer.trim().to_lowercase();
    if CANCEL_KEYWORDS.contains(&normalized.as_str()) {
        return ManualCallbackClassification::Cancelled;
    }
    let parsed = parse_authorization_input(answer);
    let (Some(code), Some(state)) = (parsed.code, parsed.state) else {
        return ManualCallbackClassification::Invalid;
    };
    if code.is_empty() || state.is_empty() {
        return ManualCallbackClassification::Invalid;
    }
    if state != expected_state {
        return ManualCallbackClassification::StateMismatch;
    }
    ManualCallbackClassification::Code { code }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE: &str = "state-123";

    fn callback_url(code: &str, state: &str) -> String {
        format!("http://localhost:1455/auth/callback?code={code}&state={state}")
    }

    #[test]
    fn closed_stream_is_cancelled() {
        assert_eq!(
            classify_manual_callback_input(None, STATE),
            ManualCallbackClassification::Cancelled
        );
    }

    #[test]
    fn esc_character_anywhere_is_cancelled() {
        assert_eq!(
            classify_manual_callback_input(Some("\u{001b}[A"), STATE),
            ManualCallbackClassification::Cancelled
        );
        assert_eq!(
            classify_manual_callback_input(
                Some(&format!("{}{}", callback_url("abc", STATE), '\u{001b}')),
                STATE
            ),
            ManualCallbackClassification::Cancelled
        );
    }

    #[test]
    fn cancel_keywords_are_cancelled_case_insensitively() {
        for keyword in ["", "  ", "q", "Q", "quit", "QUIT", "cancel", "Back"] {
            assert_eq!(
                classify_manual_callback_input(Some(keyword), STATE),
                ManualCallbackClassification::Cancelled,
                "keyword {keyword:?}"
            );
        }
    }

    #[test]
    fn missing_code_or_state_is_invalid_not_cancelled() {
        assert_eq!(
            classify_manual_callback_input(Some("http://localhost:1455/auth/callback?code=abc"), STATE),
            ManualCallbackClassification::Invalid
        );
        assert_eq!(
            classify_manual_callback_input(
                Some("http://localhost:1455/auth/callback?state=state-123"),
                STATE
            ),
            ManualCallbackClassification::Invalid
        );
        assert_eq!(
            classify_manual_callback_input(Some("not a url at all"), STATE),
            ManualCallbackClassification::Invalid
        );
    }

    #[test]
    fn wrong_state_is_a_state_mismatch() {
        assert_eq!(
            classify_manual_callback_input(Some(&callback_url("abc", "other-state")), STATE),
            ManualCallbackClassification::StateMismatch
        );
    }

    #[test]
    fn matching_state_extracts_the_code() {
        assert_eq!(
            classify_manual_callback_input(Some(&callback_url("abc123", STATE)), STATE),
            ManualCallbackClassification::Code {
                code: "abc123".to_string()
            }
        );
    }
}
