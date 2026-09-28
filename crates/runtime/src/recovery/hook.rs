//! Port of `lib/recovery.ts` (+ `lib/runtime/session-recovery.ts`) — the
//! session-recovery hook: 3-error-class detection, repair dispatch, toasts
//! (spec 11 §6.4).
//!
//! R2: library-only. The TS hook talks to the JS host's plugin client; the
//! Rust port abstracts that behind [`SessionRecoveryClient`] and is not wired
//! to any CLI/proxy surface.
//!
//! Frozen strings (spec 11 gotchas 32–33): the `"preceeding"` typo matches
//! the upstream API's misspelled error text; the injected tool-result content
//! is exactly `"Operation cancelled by user (ESC pressed)"`; the resume text
//! is `"[session recovered - continuing previous task]"`.

use std::collections::HashSet;
use std::sync::Mutex;

use cma_core::errors::CodexError;
use serde_json::Value;

use super::storage::{
    find_message_by_index_needing_thinking, find_messages_with_orphan_thinking,
    find_messages_with_thinking_blocks, prepend_thinking_part, read_parts, strip_thinking_parts,
};
use super::types::{
    MessageData, MessageInfo, MessagePart, ModelRef, RecoveryErrorType, ResumeConfig,
    ToolResultPart,
};

/// TS `RECOVERY_RESUME_TEXT`.
pub const RECOVERY_RESUME_TEXT: &str = "[session recovered - continuing previous task]";

/// The exact tool-result content injected for cancelled tools (gotcha 33).
pub const TOOL_CANCELLED_CONTENT: &str = "Operation cancelled by user (ESC pressed)";

// =============================================================================
// Error classification (pure)
// =============================================================================

/// JS falsiness over a JSON value (`!error`).
fn js_falsy(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::Number(n) => n.as_f64().is_none_or(|v| v == 0.0 || v.is_nan()),
        Value::String(s) => s.is_empty(),
        _ => false,
    }
}

fn object_message(value: &Value) -> Option<String> {
    let msg = value.as_object()?.get("message")?.as_str()?;
    if msg.is_empty() {
        return None;
    }
    Some(msg.to_lowercase())
}

/// TS private `getErrorMessage(error)` — lowercased message text probed from
/// `error.data`, `error.error`, `error` itself, then `error.data.error`;
/// falls back to the JSON serialization.
fn get_error_message(error: &Value) -> String {
    if js_falsy(error) {
        return String::new();
    }
    if let Value::String(s) = error {
        return s.to_lowercase();
    }

    let paths = [
        error.get("data"),
        error.get("error"),
        Some(error),
        error.get("data").and_then(|d| d.get("error")),
    ];
    for candidate in paths.into_iter().flatten() {
        if let Some(message) = object_message(candidate) {
            return message;
        }
    }

    serde_json::to_string(error)
        .map(|s| s.to_lowercase())
        .unwrap_or_default()
}

/// TS private `extractMessageIndex(error)` — first `/messages\.(\d+)/` match.
fn extract_message_index(error: &Value) -> Option<i64> {
    let message = get_error_message(error);
    let bytes = message.as_bytes();
    let needle = b"messages.";
    let mut start = 0usize;
    while let Some(pos) = find_subslice(&bytes[start..], needle) {
        let digits_start = start + pos + needle.len();
        let digits: String = message[digits_start..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if !digits.is_empty() {
            return digits.parse::<i64>().ok();
        }
        start += pos + needle.len();
    }
    None
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// TS `detectErrorType(error)`.
pub fn detect_error_type(error: &Value) -> Option<RecoveryErrorType> {
    let message = get_error_message(error);

    if message.contains("tool_use") && message.contains("tool_result") {
        return Some(RecoveryErrorType::ToolResultMissing);
    }

    if message.contains("thinking")
        && (message.contains("first block")
            || message.contains("must start with")
            || message.contains("preceeding")
            || (message.contains("expected") && message.contains("found")))
    {
        return Some(RecoveryErrorType::ThinkingBlockOrder);
    }

    if message.contains("thinking is disabled") && message.contains("cannot contain") {
        return Some(RecoveryErrorType::ThinkingDisabledViolation);
    }

    None
}

/// TS `isRecoverableError(error)`.
pub fn is_recoverable_error(error: &Value) -> bool {
    detect_error_type(error).is_some()
}

// =============================================================================
// Toast content (pure)
// =============================================================================

/// `{title, message}` pair for toasts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToastContent {
    pub title: String,
    pub message: String,
}

/// TS `getRecoveryToastContent(errorType)`.
pub fn get_recovery_toast_content(error_type: Option<RecoveryErrorType>) -> ToastContent {
    let (title, message) = match error_type {
        None => ("Session Recovery", "Attempting to recover session..."),
        Some(RecoveryErrorType::ToolResultMissing) => {
            ("Tool Crash Recovery", "Injecting cancelled tool results...")
        }
        Some(RecoveryErrorType::ThinkingBlockOrder) => {
            ("Thinking Block Recovery", "Fixing message structure...")
        }
        Some(RecoveryErrorType::ThinkingDisabledViolation) => {
            ("Thinking Strip Recovery", "Stripping thinking blocks...")
        }
    };
    ToastContent {
        title: title.to_string(),
        message: message.to_string(),
    }
}

/// TS `getRecoverySuccessToast()`.
pub fn get_recovery_success_toast() -> ToastContent {
    ToastContent {
        title: "Session Recovered".to_string(),
        message: "Continuing where you left off...".to_string(),
    }
}

/// TS `getRecoveryFailureToast()`.
pub fn get_recovery_failure_toast() -> ToastContent {
    ToastContent {
        title: "Recovery Failed".to_string(),
        message: "Please retry or start a new session.".to_string(),
    }
}

// =============================================================================
// Client abstraction (the TS PluginClient surface used by the hook)
// =============================================================================

/// Prompt body for `session.prompt`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PromptBody {
    pub parts: Vec<Value>,
    pub agent: Option<String>,
    pub model: Option<ModelRef>,
}

/// The host-client surface the recovery hook needs (TS `PluginInput["client"]`).
#[allow(async_fn_in_trait)]
pub trait SessionRecoveryClient {
    async fn session_abort(&self, session_id: &str) -> Result<(), CodexError>;
    async fn session_messages(
        &self,
        session_id: &str,
        directory: &str,
    ) -> Result<Vec<MessageData>, CodexError>;
    /// `directory` is `Some` only for calls that pass `query: {directory}`
    /// (the auto-resume path); tool-result injection passes `None`.
    async fn session_prompt(
        &self,
        session_id: &str,
        body: PromptBody,
        directory: Option<&str>,
    ) -> Result<(), CodexError>;
    async fn show_toast(
        &self,
        title: &str,
        message: &str,
        variant: &str,
    ) -> Result<(), CodexError>;
}

// =============================================================================
// The hook
// =============================================================================

type SessionCallback = Box<dyn Fn(&str) + Send + Sync>;

/// TS `SessionRecoveryHook` (created by [`create_session_recovery_hook`]).
pub struct SessionRecoveryHook<C> {
    client: C,
    directory: String,
    auto_resume: bool,
    processing_errors: Mutex<HashSet<String>>,
    on_abort: Mutex<Option<SessionCallback>>,
    on_recovery_complete: Mutex<Option<SessionCallback>>,
}

/// Config slice the hook needs (TS reads `config.sessionRecovery` /
/// `config.autoResume`; plugin defaults are `true` for both).
#[derive(Clone, Copy, Debug)]
pub struct SessionRecoveryConfig {
    pub session_recovery: bool,
    pub auto_resume: bool,
}

impl Default for SessionRecoveryConfig {
    fn default() -> Self {
        Self {
            session_recovery: true,
            auto_resume: true,
        }
    }
}

/// TS `createSessionRecoveryHook(ctx, config)` — `None` when
/// `config.sessionRecovery` is falsy.
pub fn create_session_recovery_hook<C: SessionRecoveryClient>(
    client: C,
    directory: impl Into<String>,
    config: SessionRecoveryConfig,
) -> Option<SessionRecoveryHook<C>> {
    if !config.session_recovery {
        return None;
    }
    Some(SessionRecoveryHook {
        client,
        directory: directory.into(),
        auto_resume: config.auto_resume,
        processing_errors: Mutex::new(HashSet::new()),
        on_abort: Mutex::new(None),
        on_recovery_complete: Mutex::new(None),
    })
}

/// TS `createRuntimeSessionRecoveryHook({enabled, client, directory,
/// autoResume})` — `None` unless enabled.
pub fn create_runtime_session_recovery_hook<C: SessionRecoveryClient>(
    enabled: bool,
    auto_resume: bool,
    client: C,
    directory: impl Into<String>,
) -> Option<SessionRecoveryHook<C>> {
    if !enabled {
        return None;
    }
    create_session_recovery_hook(
        client,
        directory,
        SessionRecoveryConfig {
            session_recovery: true,
            auto_resume,
        },
    )
}

impl<C: SessionRecoveryClient> SessionRecoveryHook<C> {
    /// TS `hook.isRecoverableError`.
    pub fn is_recoverable_error(&self, error: &Value) -> bool {
        is_recoverable_error(error)
    }

    /// TS `hook.setOnAbortCallback`.
    pub fn set_on_abort_callback(&self, callback: impl Fn(&str) + Send + Sync + 'static) {
        *self
            .on_abort
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Box::new(callback));
    }

    /// TS `hook.setOnRecoveryCompleteCallback`.
    pub fn set_on_recovery_complete_callback(
        &self,
        callback: impl Fn(&str) + Send + Sync + 'static,
    ) {
        *self
            .on_recovery_complete
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Box::new(callback));
    }

    /// TS `hook.handleSessionRecovery(info)`.
    ///
    /// `Ok(bool)` mirrors the TS resolved boolean; `Err` mirrors the one TS
    /// path that REJECTS (a `client.session.messages` failure, which happens
    /// before the internal try/catch).
    pub async fn handle_session_recovery(&self, info: &MessageInfo) -> Result<bool, CodexError> {
        if info.role.as_deref() != Some("assistant") {
            return Ok(false);
        }
        let Some(error) = info.error.as_ref().filter(|e| !js_falsy(e)) else {
            return Ok(false);
        };
        let Some(error_type) = detect_error_type(error) else {
            return Ok(false);
        };
        let Some(session_id) = info.session_id.as_deref().filter(|s| !s.is_empty()) else {
            return Ok(false);
        };

        let log = cma_core::logger::create_logger("session-recovery");
        log.debug(
            "Recovery attempt started",
            Some(&serde_json::json!({
                "errorType": error_type.as_str(),
                "sessionID": session_id,
                "providedMsgID": info.id.clone().unwrap_or_else(|| "none".to_string()),
            })),
        );

        {
            let on_abort = self
                .on_abort
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(callback) = on_abort.as_ref() {
                callback(session_id);
            }
        }

        let _ = self.client.session_abort(session_id).await;

        // NOTE: propagates on failure (matches the TS rejection path).
        let msgs = self
            .client
            .session_messages(session_id, &self.directory)
            .await?;

        let mut assistant_msg_id = info.id.clone();
        if assistant_msg_id.is_none() {
            for (i, m) in msgs.iter().enumerate().rev() {
                if let Some(msg_info) = m.info.as_ref()
                    && msg_info.role.as_deref() == Some("assistant")
                    && let Some(id) = msg_info.id.as_ref()
                {
                    assistant_msg_id = Some(id.clone());
                    log.debug(
                        "Found assistant message ID from session messages",
                        Some(&serde_json::json!({"msgID": id, "msgIndex": i})),
                    );
                    break;
                }
            }
        }

        let Some(assistant_msg_id) = assistant_msg_id else {
            log.debug("No assistant message ID found, cannot recover", None);
            return Ok(false);
        };

        // Reentrancy guard by message id.
        {
            let mut processing = self
                .processing_errors
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if processing.contains(&assistant_msg_id) {
                return Ok(false);
            }
            processing.insert(assistant_msg_id.clone());
        }

        let result = self
            .run_recovery(error_type, error, session_id, &assistant_msg_id, &msgs)
            .await;

        // "finally": drop the guard + fire the completion callback.
        {
            let mut processing = self
                .processing_errors
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            processing.remove(&assistant_msg_id);
        }
        {
            let on_complete = self
                .on_recovery_complete
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(callback) = on_complete.as_ref() {
                callback(session_id);
            }
        }

        match result {
            Ok(success) => Ok(success),
            Err(err) => {
                log.error(
                    "Recovery failed",
                    Some(&serde_json::json!({"error": err})),
                );
                Ok(false)
            }
        }
    }

    /// The TS try-block body; `Err(String)` models a caught exception.
    async fn run_recovery(
        &self,
        error_type: RecoveryErrorType,
        error: &Value,
        session_id: &str,
        assistant_msg_id: &str,
        msgs: &[MessageData],
    ) -> Result<bool, String> {
        let failed_msg = msgs
            .iter()
            .find(|m| m.info.as_ref().and_then(|i| i.id.as_deref()) == Some(assistant_msg_id));
        let Some(failed_msg) = failed_msg else {
            return Ok(false);
        };

        let toast = get_recovery_toast_content(Some(error_type));
        let _ = self
            .client
            .show_toast(&toast.title, &toast.message, "warning")
            .await;

        match error_type {
            RecoveryErrorType::ToolResultMissing => {
                self.recover_tool_result_missing(session_id, failed_msg)
                    .await
            }
            RecoveryErrorType::ThinkingBlockOrder => {
                let success = recover_thinking_block_order(session_id, error)?;
                if success && self.auto_resume {
                    let last_user = find_last_user_message(msgs);
                    let resume = extract_resume_config(last_user, session_id);
                    let _ = self.resume_session(&resume).await;
                }
                Ok(success)
            }
            RecoveryErrorType::ThinkingDisabledViolation => {
                let success = recover_thinking_disabled_violation(session_id)?;
                if success && self.auto_resume {
                    let last_user = find_last_user_message(msgs);
                    let resume = extract_resume_config(last_user, session_id);
                    let _ = self.resume_session(&resume).await;
                }
                Ok(success)
            }
        }
    }

    async fn recover_tool_result_missing(
        &self,
        session_id: &str,
        failed_msg: &MessageData,
    ) -> Result<bool, String> {
        let mut parts: Vec<MessagePart> = failed_msg.parts.clone().unwrap_or_default();
        if parts.is_empty()
            && let Some(msg_id) = failed_msg.info.as_ref().and_then(|i| i.id.as_deref())
        {
            // read_parts propagates an invalid-id error into the catch path.
            let stored_parts = read_parts(msg_id)?;
            parts = stored_parts
                .iter()
                .map(|p| MessagePart {
                    part_type: if p.part_type == "tool" {
                        "tool_use".to_string()
                    } else {
                        p.part_type.clone()
                    },
                    id: if p.has_call_id_key() {
                        p.call_id().map(str::to_string)
                    } else {
                        Some(p.id.clone())
                    },
                    name: p.tool().map(str::to_string),
                    input: p.state_input().cloned(),
                    ..MessagePart::default()
                })
                .collect();
        }

        let tool_use_ids: Vec<String> = parts
            .iter()
            .filter(|p| p.part_type == "tool_use")
            .filter_map(|p| p.id.clone())
            .filter(|id| !id.is_empty())
            .collect();

        if tool_use_ids.is_empty() {
            return Ok(false);
        }

        let tool_result_parts: Vec<Value> = tool_use_ids
            .iter()
            .map(|id| {
                serde_json::to_value(ToolResultPart::new(id.clone(), TOOL_CANCELLED_CONTENT))
                    .expect("ToolResultPart serializes")
            })
            .collect();

        let body = PromptBody {
            parts: tool_result_parts,
            agent: None,
            model: None,
        };
        Ok(self
            .client
            .session_prompt(session_id, body, None)
            .await
            .is_ok())
    }

    async fn resume_session(&self, config: &ResumeConfig) -> bool {
        let body = PromptBody {
            parts: vec![serde_json::json!({"type": "text", "text": RECOVERY_RESUME_TEXT})],
            agent: config.agent.clone(),
            model: config.model.clone(),
        };
        self.client
            .session_prompt(&config.session_id, body, Some(&self.directory))
            .await
            .is_ok()
    }
}

fn recover_thinking_block_order(session_id: &str, error: &Value) -> Result<bool, String> {
    if let Some(target_index) = extract_message_index(error)
        && let Some(target_message_id) =
            find_message_by_index_needing_thinking(session_id, target_index)?
    {
        return Ok(prepend_thinking_part(session_id, &target_message_id));
    }

    let orphan_messages = find_messages_with_orphan_thinking(session_id)?;
    if orphan_messages.is_empty() {
        return Ok(false);
    }

    let mut any_success = false;
    for message_id in &orphan_messages {
        if prepend_thinking_part(session_id, message_id) {
            any_success = true;
        }
    }
    Ok(any_success)
}

fn recover_thinking_disabled_violation(session_id: &str) -> Result<bool, String> {
    let messages_with_thinking = find_messages_with_thinking_blocks(session_id)?;
    if messages_with_thinking.is_empty() {
        return Ok(false);
    }

    let mut any_success = false;
    for message_id in &messages_with_thinking {
        if strip_thinking_parts(message_id) {
            any_success = true;
        }
    }
    Ok(any_success)
}

fn find_last_user_message(messages: &[MessageData]) -> Option<&MessageData> {
    messages
        .iter()
        .rev()
        .find(|m| m.info.as_ref().and_then(|i| i.role.as_deref()) == Some("user"))
}

fn extract_resume_config(user_message: Option<&MessageData>, session_id: &str) -> ResumeConfig {
    ResumeConfig {
        session_id: session_id.to_string(),
        agent: user_message
            .and_then(|m| m.info.as_ref())
            .and_then(|i| i.agent.clone()),
        model: user_message
            .and_then(|m| m.info.as_ref())
            .and_then(|i| i.model.clone()),
    }
}

// =============================================================================
// Tests — ported from test/recovery.test.ts (classification + toasts)
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detects_tool_result_missing() {
        let error = json!({"message": "Each `tool_use` block must have a corresponding `tool_result`"});
        assert_eq!(
            detect_error_type(&error),
            Some(RecoveryErrorType::ToolResultMissing)
        );
        assert!(is_recoverable_error(&error));
    }

    #[test]
    fn detects_thinking_block_order_variants() {
        for msg in [
            "messages.3: thinking block must be the first block",
            "thinking must start with a thinking block",
            "thinking blocks: preceeding turn was cancelled",
            "expected thinking but found text",
        ] {
            assert_eq!(
                detect_error_type(&json!({"message": msg})),
                Some(RecoveryErrorType::ThinkingBlockOrder),
                "message: {msg}"
            );
        }
    }

    #[test]
    fn detects_thinking_disabled_violation() {
        let error =
            json!({"message": "Thinking is disabled; messages cannot contain thinking blocks"});
        assert_eq!(
            detect_error_type(&error),
            Some(RecoveryErrorType::ThinkingDisabledViolation)
        );
    }

    #[test]
    fn returns_none_for_unrelated_errors() {
        assert_eq!(detect_error_type(&json!({"message": "rate limited"})), None);
        assert_eq!(detect_error_type(&Value::Null), None);
        assert_eq!(detect_error_type(&json!("")), None);
        assert!(!is_recoverable_error(&json!({"message": "boom"})));
    }

    #[test]
    fn probes_nested_error_shapes() {
        // error.data.message
        let e1 = json!({"data": {"message": "tool_use without tool_result"}});
        assert_eq!(detect_error_type(&e1), Some(RecoveryErrorType::ToolResultMissing));
        // error.error.message
        let e2 = json!({"error": {"message": "tool_use without tool_result"}});
        assert_eq!(detect_error_type(&e2), Some(RecoveryErrorType::ToolResultMissing));
        // error.data.error.message
        let e3 = json!({"data": {"error": {"message": "tool_use without tool_result"}}});
        assert_eq!(detect_error_type(&e3), Some(RecoveryErrorType::ToolResultMissing));
        // Plain string
        let e4 = json!("TOOL_USE and TOOL_RESULT mismatch");
        assert_eq!(detect_error_type(&e4), Some(RecoveryErrorType::ToolResultMissing));
        // JSON.stringify fallback
        let e5 = json!({"other": "tool_use ... tool_result"});
        assert_eq!(detect_error_type(&e5), Some(RecoveryErrorType::ToolResultMissing));
    }

    #[test]
    fn extract_message_index_parses_first_match() {
        assert_eq!(
            extract_message_index(&json!({"message": "messages.12: thinking block"})),
            Some(12)
        );
        assert_eq!(
            extract_message_index(&json!({"message": "no index here"})),
            None
        );
        assert_eq!(
            extract_message_index(&json!({"message": "messages.x then messages.7"})),
            Some(7)
        );
    }

    #[test]
    fn toast_content_matches_ts_strings() {
        assert_eq!(
            get_recovery_toast_content(None),
            ToastContent {
                title: "Session Recovery".into(),
                message: "Attempting to recover session...".into()
            }
        );
        assert_eq!(
            get_recovery_toast_content(Some(RecoveryErrorType::ToolResultMissing)),
            ToastContent {
                title: "Tool Crash Recovery".into(),
                message: "Injecting cancelled tool results...".into()
            }
        );
        assert_eq!(
            get_recovery_toast_content(Some(RecoveryErrorType::ThinkingBlockOrder)),
            ToastContent {
                title: "Thinking Block Recovery".into(),
                message: "Fixing message structure...".into()
            }
        );
        assert_eq!(
            get_recovery_toast_content(Some(RecoveryErrorType::ThinkingDisabledViolation)),
            ToastContent {
                title: "Thinking Strip Recovery".into(),
                message: "Stripping thinking blocks...".into()
            }
        );
        assert_eq!(get_recovery_success_toast().title, "Session Recovered");
        assert_eq!(
            get_recovery_failure_toast().message,
            "Please retry or start a new session."
        );
    }

    #[test]
    fn create_hook_respects_session_recovery_flag() {
        struct NullClient;
        impl SessionRecoveryClient for NullClient {
            async fn session_abort(&self, _: &str) -> Result<(), CodexError> {
                Ok(())
            }
            async fn session_messages(
                &self,
                _: &str,
                _: &str,
            ) -> Result<Vec<MessageData>, CodexError> {
                Ok(Vec::new())
            }
            async fn session_prompt(
                &self,
                _: &str,
                _: PromptBody,
                _: Option<&str>,
            ) -> Result<(), CodexError> {
                Ok(())
            }
            async fn show_toast(&self, _: &str, _: &str, _: &str) -> Result<(), CodexError> {
                Ok(())
            }
        }

        assert!(
            create_session_recovery_hook(
                NullClient,
                "/dir",
                SessionRecoveryConfig {
                    session_recovery: false,
                    auto_resume: true
                }
            )
            .is_none()
        );
        assert!(create_runtime_session_recovery_hook(false, true, NullClient, "/dir").is_none());
        assert!(create_runtime_session_recovery_hook(true, true, NullClient, "/dir").is_some());
    }

    #[tokio::test]
    async fn handle_session_recovery_rejects_non_assistant_and_no_error() {
        struct NullClient;
        impl SessionRecoveryClient for NullClient {
            async fn session_abort(&self, _: &str) -> Result<(), CodexError> {
                Ok(())
            }
            async fn session_messages(
                &self,
                _: &str,
                _: &str,
            ) -> Result<Vec<MessageData>, CodexError> {
                Ok(Vec::new())
            }
            async fn session_prompt(
                &self,
                _: &str,
                _: PromptBody,
                _: Option<&str>,
            ) -> Result<(), CodexError> {
                Ok(())
            }
            async fn show_toast(&self, _: &str, _: &str, _: &str) -> Result<(), CodexError> {
                Ok(())
            }
        }
        let hook = create_session_recovery_hook(NullClient, "/dir", SessionRecoveryConfig::default())
            .unwrap();

        let mut info = MessageInfo {
            role: Some("user".to_string()),
            error: Some(json!({"message": "tool_use tool_result"})),
            session_id: Some("ses1".to_string()),
            ..MessageInfo::default()
        };
        assert!(!hook.handle_session_recovery(&info).await.unwrap());

        info.role = Some("assistant".to_string());
        info.error = None;
        assert!(!hook.handle_session_recovery(&info).await.unwrap());

        // Recoverable error but no session id.
        info.error = Some(json!({"message": "tool_use tool_result"}));
        info.session_id = None;
        assert!(!hook.handle_session_recovery(&info).await.unwrap());
    }
}
