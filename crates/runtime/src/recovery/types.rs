//! Port of `lib/recovery/types.ts` — session-recovery record shapes
//! (spec 11 §6.2).
//!
//! Storage records are read tolerantly: the TS validators only require a
//! SAFE string `id` (+ string `type` for parts, and a finite numeric
//! `time.created` when `time` is present). Everything else is permissive, so
//! the Rust structs model non-guaranteed fields as `Option`/`Value` and keep
//! unknown keys in `extra` (round-trip safe: the repair paths rewrite files).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// TS `StoredMessageMeta` — message metadata on disk. Only `id` is
/// guaranteed by validation; `role`/`time` may be missing or partial.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StoredMessageMeta {
    pub id: String,
    #[serde(rename = "sessionID", default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(rename = "parentID", default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<StoredMessageTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
    /// Unknown keys survive (tolerant read).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl StoredMessageMeta {
    /// TS `msg.role === "assistant"` check.
    pub fn is_assistant(&self) -> bool {
        self.role.as_deref() == Some("assistant")
    }

    /// TS `msg.role === "user"` check.
    pub fn is_user(&self) -> bool {
        self.role.as_deref() == Some("user")
    }

    /// TS `a?.time?.created ?? 0` sort key (float-preserving).
    pub fn created_sort_key(&self) -> f64 {
        self.time
            .as_ref()
            .and_then(|t| t.created.as_ref())
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    }
}

/// The `time` object of a stored message. `created` is kept as a raw
/// [`Value`] because validation only constrains it *when present*.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StoredMessageTime {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<Value>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// TS `StoredPart` — the open union of stored part shapes. Only `id` and
/// `type` are validated; the typed accessors below expose the fields the
/// recovery paths need (`text`, `callID`, `tool`, `state.input`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StoredPart {
    pub id: String,
    #[serde(rename = "sessionID", default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(rename = "messageID", default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(rename = "type")]
    pub part_type: String,
    /// Unknown/typed-variant keys (text, callID, tool, state, thinking,
    /// synthetic, ignored, ...) kept raw for tolerant round-trips.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl StoredPart {
    /// The `text` field when it is a string (non-string values behave as
    /// missing — see storage.rs `has_content` note).
    pub fn text(&self) -> Option<&str> {
        self.extra.get("text").and_then(Value::as_str)
    }

    /// Whether the raw record carries a `callID` key at all (TS `"callID" in p`).
    pub fn has_call_id_key(&self) -> bool {
        self.extra.contains_key("callID")
    }

    /// The `callID` value when it is a string.
    pub fn call_id(&self) -> Option<&str> {
        self.extra.get("callID").and_then(Value::as_str)
    }

    /// The `tool` name when it is a string.
    pub fn tool(&self) -> Option<&str> {
        self.extra.get("tool").and_then(Value::as_str)
    }

    /// `state.input` when present.
    pub fn state_input(&self) -> Option<&Value> {
        self.extra.get("state").and_then(|s| s.get("input"))
    }
}

// =============================================================================
// API types (host SDK responses)
// =============================================================================

/// TS `MessagePart` (API shape).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MessagePart {
    #[serde(rename = "type")]
    pub part_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(rename = "callID", default, skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
}

/// Model reference (`{providerID, modelID}`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRef {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(rename = "modelID")]
    pub model_id: String,
}

/// TS `MessageData.info`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MessageDataInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(rename = "sessionID", default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(rename = "parentID", default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Value>,
}

/// TS `MessageData` (API message).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MessageData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub info: Option<MessageDataInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<MessagePart>>,
}

/// TS `MessageInfo` — the hook input.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MessageInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(rename = "sessionID", default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(rename = "parentID", default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

/// TS `ResumeConfig`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResumeConfig {
    #[serde(rename = "sessionID")]
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
}

/// TS `RecoveryErrorType` (non-null variants; the TS `null` is
/// `Option::<RecoveryErrorType>::None`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RecoveryErrorType {
    #[serde(rename = "tool_result_missing")]
    ToolResultMissing,
    #[serde(rename = "thinking_block_order")]
    ThinkingBlockOrder,
    #[serde(rename = "thinking_disabled_violation")]
    ThinkingDisabledViolation,
}

impl RecoveryErrorType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ToolResultMissing => "tool_result_missing",
            Self::ThinkingBlockOrder => "thinking_block_order",
            Self::ThinkingDisabledViolation => "thinking_disabled_violation",
        }
    }
}

/// TS `ToolResultPart`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolResultPart {
    /// Always `"tool_result"`.
    #[serde(rename = "type")]
    pub part_type: String,
    pub tool_use_id: String,
    pub content: String,
}

impl ToolResultPart {
    pub fn new(tool_use_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            part_type: "tool_result".to_string(),
            tool_use_id: tool_use_id.into(),
            content: content.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stored_part_accessors_read_variant_fields() {
        let part: StoredPart = serde_json::from_value(json!({
            "id": "prt_1", "sessionID": "s", "messageID": "m",
            "type": "tool", "callID": "call_9", "tool": "bash",
            "state": {"status": "running", "input": {"cmd": "ls"}}
        }))
        .unwrap();
        assert!(part.has_call_id_key());
        assert_eq!(part.call_id(), Some("call_9"));
        assert_eq!(part.tool(), Some("bash"));
        assert_eq!(part.state_input().unwrap()["cmd"], json!("ls"));
        assert_eq!(part.text(), None);
    }

    #[test]
    fn stored_message_sort_key_defaults_to_zero() {
        let msg: StoredMessageMeta =
            serde_json::from_value(json!({"id": "m1", "role": "assistant"})).unwrap();
        assert_eq!(msg.created_sort_key(), 0.0);
        assert!(msg.is_assistant());
        let with_time: StoredMessageMeta =
            serde_json::from_value(json!({"id": "m2", "time": {"created": 5.5}})).unwrap();
        assert_eq!(with_time.created_sort_key(), 5.5);
    }

    #[test]
    fn stored_records_round_trip_unknown_keys() {
        let raw = json!({"id": "m1", "custom": {"a": 1}, "role": "user"});
        let msg: StoredMessageMeta = serde_json::from_value(raw.clone()).unwrap();
        let back = serde_json::to_value(&msg).unwrap();
        assert_eq!(back["custom"], raw["custom"]);
    }
}
