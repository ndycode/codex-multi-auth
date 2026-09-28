//! Port of `lib/request/helpers/input-utils.ts` — input-list surgery
//! (spec 06 §3): host-prompt stripping, orphaned tool-output conversion, and
//! missing-tool-output injection.
//!
//! All functions are pure; items are the permissive
//! [`cma_core::types::InputItem`] model (unknown keys ride in `extra`).

use cma_core::types::InputItem;
use serde_json::{Map, Value, json};

/// TS `HOST_PROMPT_SIGNATURES` — already lowercased (the TS module lowercases
/// them at init).
const HOST_PROMPT_SIGNATURES: [&str; 5] = [
    "you are a coding agent running in the codex",
    "you are codex, an agent",
    "you are codex, an interactive cli agent",
    "you are codex, an interactive cli tool",
    "you are codex, the best coding agent on the planet",
];

/// TS `HOST_CONTEXT_MARKERS` — already lowercased.
const HOST_CONTEXT_MARKERS: [&str; 4] = [
    "here is some useful information about the environment you are running in:",
    "<env>",
    "instructions from:",
    "<instructions>",
];

/// TS `getContentText` — string content as-is; array content joins the `text`
/// of parts with `type === "input_text"` and a truthy (non-empty string)
/// `text` with `"\n"`; anything else → `""`.
pub fn get_content_text(item: &InputItem) -> String {
    match &item.content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                let obj = part.as_object()?;
                if obj.get("type").and_then(Value::as_str) != Some("input_text") {
                    return None;
                }
                match obj.get("text") {
                    Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
                    _ => None,
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// TS `replaceContentText` — string content stays a string; array content
/// becomes `[{type:"input_text", text}]`; the (unreachable in practice)
/// fallback also writes a plain string.
fn replace_content_text(mut item: InputItem, content_text: &str) -> InputItem {
    item.content = match &item.content {
        Some(Value::Array(_)) => Some(json!([{ "type": "input_text", "text": content_text }])),
        _ => Some(Value::String(content_text.to_string())),
    };
    item
}

/// ASCII case-insensitive substring search returning the byte index in
/// `haystack`. All host-context markers are pure ASCII, so the returned index
/// is always a valid char boundary of the ORIGINAL string (the TS code
/// lowercases the whole content and indexes into that instead; for ASCII
/// markers the two are equivalent).
fn find_ascii_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    let haystack_bytes = haystack.as_bytes();
    let needle_bytes = needle.as_bytes();
    if needle_bytes.is_empty() || needle_bytes.len() > haystack_bytes.len() {
        return None;
    }
    (0..=haystack_bytes.len() - needle_bytes.len()).find(|&index| {
        haystack_bytes[index..index + needle_bytes.len()].eq_ignore_ascii_case(needle_bytes)
    })
}

/// TS `extractHostContext` — the slice from the EARLIEST context marker,
/// `trimStart`ed; `None` when no marker is present.
fn extract_host_context(content_text: &str) -> Option<String> {
    let earliest = HOST_CONTEXT_MARKERS
        .iter()
        .filter_map(|marker| find_ascii_case_insensitive(content_text, marker))
        .min()?;
    Some(content_text[earliest..].trim_start().to_string())
}

/// TS `isHostSystemPrompt`.
///
/// Role must be exactly `"developer"` or `"system"` (case-sensitive, TS
/// parity). With a non-empty `cached_prompt`: exact trimmed match, OR content
/// starts with the cached prompt, OR first-200-chars equality — any hit wins.
/// Regardless of the cached prompt, the lowercased/trim-started content
/// starting with one of the known host-prompt signatures also matches.
pub fn is_host_system_prompt(item: &InputItem, cached_prompt: Option<&str>) -> bool {
    let is_system_role = matches!(item.role.as_deref(), Some("developer") | Some("system"));
    if !is_system_role {
        return false;
    }

    let content_text = get_content_text(item);
    if content_text.is_empty() {
        return false;
    }

    if let Some(cached) = cached_prompt.filter(|cached| !cached.is_empty()) {
        let content_trimmed = content_text.trim();
        let cached_trimmed = cached.trim();
        if content_trimmed == cached_trimmed {
            return true;
        }
        if content_trimmed.starts_with(cached_trimmed) {
            return true;
        }
        // TS `substring(0, 200)` — first 200 chars of each side compared.
        let content_prefix: String = content_trimmed.chars().take(200).collect();
        let cached_prefix: String = cached_trimmed.chars().take(200).collect();
        if content_prefix == cached_prefix {
            return true;
        }
    }

    let normalized = content_text.trim_start().to_lowercase();
    HOST_PROMPT_SIGNATURES
        .iter()
        .any(|signature| normalized.starts_with(signature))
}

/// TS `filterHostSystemPromptsWithCachedPrompt` — user-role items always kept;
/// detected host prompts either keep only their host-context slice or are
/// dropped entirely. `None` input passes through (TS non-array passthrough).
pub fn filter_host_system_prompts_with_cached_prompt(
    input: Option<Vec<InputItem>>,
    cached_prompt: Option<&str>,
) -> Option<Vec<InputItem>> {
    let input = input?;
    Some(
        input
            .into_iter()
            .flat_map(|item| {
                if item.role.as_deref() == Some("user") {
                    return vec![item];
                }
                if !is_host_system_prompt(&item, cached_prompt) {
                    return vec![item];
                }
                let content_text = get_content_text(&item);
                match extract_host_context(&content_text) {
                    Some(preserved) if !preserved.is_empty() => {
                        vec![replace_content_text(item, &preserved)]
                    }
                    _ => vec![],
                }
            })
            .collect(),
    )
}

/// TS `getCallId` — trimmed non-empty string `call_id`, else `None`.
fn get_call_id(item: &InputItem) -> Option<String> {
    let raw = item.extra.get("call_id")?.as_str()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// TS orphan-conversion truncation limit.
const MAX_ORPHAN_OUTPUT_CHARS: usize = 16_000;

/// TS `convertOrphanedOutputToMessage` — the orphaned `*_output` item becomes
/// an assistant message
/// `"[Previous {toolName} result; call_id={id|unknown}]: {text}"` where text
/// is the string output, or `JSON.stringify` of a non-string output, truncated
/// at 16000 chars with a `"\n...[truncated]"` suffix.
fn convert_orphaned_output_to_message(item: &InputItem, call_id: Option<&str>) -> InputItem {
    let tool_name = item
        .extra
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let label_call_id = call_id.unwrap_or("unknown");
    let mut text = match item.extra.get("output") {
        Some(Value::String(output)) => output.clone(),
        // JSON.stringify(out); serde_json cannot fail on a Value (no circular
        // refs / bigints exist), so the TS catch-path `String(output ?? "")`
        // is unreachable here.
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
        // TS: JSON.stringify(undefined) → undefined; Rust treats a missing
        // output as the empty string.
        None => String::new(),
    };
    if text.chars().count() > MAX_ORPHAN_OUTPUT_CHARS {
        let truncated: String = text.chars().take(MAX_ORPHAN_OUTPUT_CHARS).collect();
        text = format!("{truncated}\n...[truncated]");
    }
    InputItem {
        id: None,
        kind: Some("message".to_string()),
        role: Some("assistant".to_string()),
        content: Some(Value::String(format!(
            "[Previous {tool_name} result; call_id={label_call_id}]: {text}"
        ))),
        extra: Map::new(),
    }
}

/// TS `collectCallIds` — call ids of `function_call` / `local_shell_call` /
/// `custom_tool_call` items.
struct CallIds {
    function_call_ids: Vec<String>,
    local_shell_call_ids: Vec<String>,
    custom_tool_call_ids: Vec<String>,
}

fn collect_call_ids(input: &[InputItem]) -> CallIds {
    let mut ids = CallIds {
        function_call_ids: Vec::new(),
        local_shell_call_ids: Vec::new(),
        custom_tool_call_ids: Vec::new(),
    };
    for item in input {
        let Some(call_id) = get_call_id(item) else {
            continue;
        };
        match item.kind.as_deref() {
            Some("function_call") => ids.function_call_ids.push(call_id),
            Some("local_shell_call") => ids.local_shell_call_ids.push(call_id),
            Some("custom_tool_call") => ids.custom_tool_call_ids.push(call_id),
            _ => {}
        }
    }
    ids
}

/// TS `normalizeOrphanedToolOutputs` — outputs with no matching call anywhere
/// in the list are converted to assistant messages (never dropped, so the
/// model keeps the tool-result context). Matching rules:
/// - `function_call_output` matches a `function_call` OR `local_shell_call` id;
/// - `custom_tool_call_output` matches a `custom_tool_call` id;
/// - `local_shell_call_output` matches a `local_shell_call` id.
pub fn normalize_orphaned_tool_outputs(input: Vec<InputItem>) -> Vec<InputItem> {
    let ids = collect_call_ids(&input);
    input
        .into_iter()
        .map(|item| {
            let call_id = get_call_id(&item);
            let has_match = |haystack: &[String]| {
                call_id
                    .as_deref()
                    .map(|id| haystack.iter().any(|known| known == id))
                    .unwrap_or(false)
            };
            match item.kind.as_deref() {
                Some("function_call_output") => {
                    if has_match(&ids.function_call_ids) || has_match(&ids.local_shell_call_ids) {
                        item
                    } else {
                        convert_orphaned_output_to_message(&item, call_id.as_deref())
                    }
                }
                Some("custom_tool_call_output") => {
                    if has_match(&ids.custom_tool_call_ids) {
                        item
                    } else {
                        convert_orphaned_output_to_message(&item, call_id.as_deref())
                    }
                }
                Some("local_shell_call_output") => {
                    if has_match(&ids.local_shell_call_ids) {
                        item
                    } else {
                        convert_orphaned_output_to_message(&item, call_id.as_deref())
                    }
                }
                _ => item,
            }
        })
        .collect()
}

/// TS `CANCELLED_TOOL_OUTPUT` — frozen user-visible string.
const CANCELLED_TOOL_OUTPUT: &str = "Operation cancelled by user";

/// TS `collectOutputCallIds`.
fn collect_output_call_ids(input: &[InputItem]) -> Vec<String> {
    input
        .iter()
        .filter(|item| {
            matches!(
                item.kind.as_deref(),
                Some("function_call_output")
                    | Some("local_shell_call_output")
                    | Some("custom_tool_call_output")
            )
        })
        .filter_map(get_call_id)
        .collect()
}

/// TS `injectMissingToolOutputs` — for every call item whose call_id has no
/// corresponding `*_output` anywhere in the input, insert
/// `{ type: <matching output type>, call_id, output: "Operation cancelled by user" }`
/// immediately after it.
pub fn inject_missing_tool_outputs(input: Vec<InputItem>) -> Vec<InputItem> {
    let output_call_ids = collect_output_call_ids(&input);
    let mut result: Vec<InputItem> = Vec::with_capacity(input.len());

    for item in input {
        let kind = item.kind.clone();
        let call_id = get_call_id(&item);
        result.push(item);

        let output_type = match kind.as_deref() {
            Some("function_call") => "function_call_output",
            Some("local_shell_call") => "local_shell_call_output",
            Some("custom_tool_call") => "custom_tool_call_output",
            _ => continue,
        };
        let Some(call_id) = call_id else { continue };
        if output_call_ids.iter().any(|known| known == &call_id) {
            continue;
        }
        let mut extra = Map::new();
        extra.insert("call_id".to_string(), Value::String(call_id));
        extra.insert(
            "output".to_string(),
            Value::String(CANCELLED_TOOL_OUTPUT.to_string()),
        );
        result.push(InputItem {
            id: None,
            kind: Some(output_type.to_string()),
            role: None,
            content: None,
            extra,
        });
    }

    result
}

// ===========================================================================
// Tests — ported from test/input-utils.test.ts
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn item(value: Value) -> InputItem {
        serde_json::from_value(value).expect("test item must parse")
    }

    fn items(value: Value) -> Vec<InputItem> {
        serde_json::from_value(value).expect("test items must parse")
    }

    // --- injectMissingToolOutputs -----------------------------------------

    #[test]
    fn inject_returns_empty_for_empty_input() {
        assert!(inject_missing_tool_outputs(Vec::new()).is_empty());
    }

    #[test]
    fn inject_passes_through_input_with_no_function_calls() {
        let input = items(json!([
            { "type": "message", "role": "user", "content": "Hello" },
            { "type": "message", "role": "assistant", "content": "Hi there" },
        ]));
        assert_eq!(inject_missing_tool_outputs(input.clone()), input);
    }

    #[test]
    fn inject_passes_through_function_call_with_matching_output() {
        let input = items(json!([
            { "type": "function_call", "role": "assistant", "call_id": "call_1", "name": "test" },
            { "type": "function_call_output", "role": "tool", "call_id": "call_1", "output": "result" },
        ]));
        let result = inject_missing_tool_outputs(input);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].kind.as_deref(), Some("function_call"));
        assert_eq!(result[1].kind.as_deref(), Some("function_call_output"));
    }

    #[test]
    fn inject_injects_output_for_orphaned_function_call() {
        let input = items(json!([
            { "type": "message", "role": "user", "content": "run the tool" },
            { "type": "function_call", "role": "assistant", "call_id": "call_orphan", "name": "read_file" },
        ]));
        let result = inject_missing_tool_outputs(input);
        assert_eq!(result.len(), 3);
        assert_eq!(result[2].kind.as_deref(), Some("function_call_output"));
        assert_eq!(
            result[2].extra.get("call_id"),
            Some(&Value::String("call_orphan".to_string()))
        );
        assert_eq!(
            result[2].extra.get("output"),
            Some(&Value::String("Operation cancelled by user".to_string()))
        );
    }

    #[test]
    fn inject_injects_output_for_orphaned_local_shell_call() {
        let input = items(json!([
            { "type": "local_shell_call", "role": "assistant", "call_id": "shell_1", "command": "ls" },
        ]));
        let result = inject_missing_tool_outputs(input);
        assert_eq!(result.len(), 2);
        assert_eq!(result[1].kind.as_deref(), Some("local_shell_call_output"));
        assert_eq!(
            result[1].extra.get("call_id"),
            Some(&Value::String("shell_1".to_string()))
        );
    }

    #[test]
    fn inject_injects_output_for_orphaned_custom_tool_call() {
        let input = items(json!([
            { "type": "custom_tool_call", "role": "assistant", "call_id": "custom_1", "name": "my_tool" },
        ]));
        let result = inject_missing_tool_outputs(input);
        assert_eq!(result.len(), 2);
        assert_eq!(result[1].kind.as_deref(), Some("custom_tool_call_output"));
    }

    #[test]
    fn inject_handles_multiple_orphaned_calls() {
        let input = items(json!([
            { "type": "function_call", "role": "assistant", "call_id": "call_1", "name": "tool1" },
            { "type": "function_call", "role": "assistant", "call_id": "call_2", "name": "tool2" },
            { "type": "function_call", "role": "assistant", "call_id": "call_3", "name": "tool3" },
        ]));
        let result = inject_missing_tool_outputs(input);
        assert_eq!(result.len(), 6);
        assert_eq!(
            result
                .iter()
                .filter(|i| i.kind.as_deref() == Some("function_call_output"))
                .count(),
            3
        );
    }

    #[test]
    fn inject_only_injects_for_calls_without_outputs() {
        let input = items(json!([
            { "type": "function_call", "role": "assistant", "call_id": "call_with_output", "name": "tool1" },
            { "type": "function_call_output", "role": "tool", "call_id": "call_with_output", "output": "done" },
            { "type": "function_call", "role": "assistant", "call_id": "call_without_output", "name": "tool2" },
        ]));
        let result = inject_missing_tool_outputs(input);
        assert_eq!(result.len(), 4);
        assert_eq!(
            result
                .iter()
                .filter(|i| i.kind.as_deref() == Some("function_call_output"))
                .count(),
            2
        );
    }

    #[test]
    fn inject_skips_calls_without_call_id() {
        let input = items(json!([
            { "type": "function_call", "role": "assistant", "name": "no_id_tool" },
        ]));
        assert_eq!(inject_missing_tool_outputs(input).len(), 1);
    }

    #[test]
    fn inject_places_output_immediately_after_the_call() {
        let input = items(json!([
            { "type": "message", "role": "user", "content": "start" },
            { "type": "function_call", "role": "assistant", "call_id": "call_A", "name": "toolA" },
            { "type": "message", "role": "user", "content": "middle" },
            { "type": "function_call", "role": "assistant", "call_id": "call_B", "name": "toolB" },
            { "type": "message", "role": "user", "content": "end" },
        ]));
        let result = inject_missing_tool_outputs(input);
        assert_eq!(result.len(), 7);
        let kinds: Vec<_> = result.iter().map(|i| i.kind.as_deref().unwrap()).collect();
        assert_eq!(
            kinds,
            vec![
                "message",
                "function_call",
                "function_call_output",
                "message",
                "function_call",
                "function_call_output",
                "message",
            ]
        );
        assert_eq!(
            result[2].extra.get("call_id"),
            Some(&Value::String("call_A".to_string()))
        );
        assert_eq!(
            result[5].extra.get("call_id"),
            Some(&Value::String("call_B".to_string()))
        );
    }

    #[test]
    fn injected_output_serializes_with_ts_key_order() {
        let input = items(json!([
            { "type": "function_call", "role": "assistant", "call_id": "c1", "name": "t" },
        ]));
        let result = inject_missing_tool_outputs(input);
        let serialized = serde_json::to_string(&result[1]).unwrap();
        assert_eq!(
            serialized,
            r#"{"type":"function_call_output","call_id":"c1","output":"Operation cancelled by user"}"#
        );
    }

    // --- normalizeOrphanedToolOutputs -------------------------------------

    #[test]
    fn normalize_converts_orphaned_function_call_output_to_message() {
        let input = items(json!([
            { "type": "function_call_output", "role": "tool", "call_id": "orphan_call", "output": "some result" },
        ]));
        let result = normalize_orphaned_tool_outputs(input);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].kind.as_deref(), Some("message"));
        assert_eq!(result[0].role.as_deref(), Some("assistant"));
    }

    #[test]
    fn normalize_preserves_function_call_output_with_matching_call() {
        let input = items(json!([
            { "type": "function_call", "role": "assistant", "call_id": "matched_call", "name": "test" },
            { "type": "function_call_output", "role": "tool", "call_id": "matched_call", "output": "result" },
        ]));
        let result = normalize_orphaned_tool_outputs(input);
        assert_eq!(result.len(), 2);
        assert_eq!(result[1].kind.as_deref(), Some("function_call_output"));
    }

    #[test]
    fn normalize_converts_orphaned_local_shell_call_output_to_message() {
        let input = items(json!([
            { "type": "local_shell_call_output", "role": "tool", "call_id": "orphan_shell", "output": "shell result" },
        ]));
        let result = normalize_orphaned_tool_outputs(input);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].kind.as_deref(), Some("message"));
        assert_eq!(result[0].role.as_deref(), Some("assistant"));
    }

    #[test]
    fn normalize_preserves_local_shell_call_output_with_matching_call() {
        let input = items(json!([
            { "type": "local_shell_call", "role": "assistant", "call_id": "shell_matched", "command": "ls" },
            { "type": "local_shell_call_output", "role": "tool", "call_id": "shell_matched", "output": "files" },
        ]));
        let result = normalize_orphaned_tool_outputs(input);
        assert_eq!(result.len(), 2);
        assert_eq!(result[1].kind.as_deref(), Some("local_shell_call_output"));
    }

    #[test]
    fn normalize_function_call_output_matches_local_shell_call_ids_too() {
        let input = items(json!([
            { "type": "local_shell_call", "call_id": "shell_call", "action": {"type": "exec"} },
            { "type": "function_call_output", "call_id": "shell_call", "output": "ok" },
        ]));
        let result = normalize_orphaned_tool_outputs(input);
        assert_eq!(result[1].kind.as_deref(), Some("function_call_output"));
    }

    #[test]
    fn normalize_truncates_very_long_output_content() {
        let long_output = "x".repeat(20_000);
        let input = items(json!([
            { "type": "function_call_output", "role": "tool", "call_id": "orphan_long", "output": long_output },
        ]));
        let result = normalize_orphaned_tool_outputs(input);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].kind.as_deref(), Some("message"));
        let content = result[0]
            .content
            .as_ref()
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(content.len() < 20_000);
        assert!(content.contains("[truncated]"));
    }

    #[test]
    fn normalize_converts_non_string_output_to_json() {
        let input = items(json!([
            { "type": "function_call_output", "role": "tool", "call_id": "orphan_obj", "output": { "key": "value" } },
        ]));
        let result = normalize_orphaned_tool_outputs(input);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].kind.as_deref(), Some("message"));
        let content = result[0]
            .content
            .as_ref()
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(content.contains("key"));
        assert!(content.contains("value"));
    }

    #[test]
    fn normalize_message_label_uses_name_and_call_id() {
        let input = items(json!([
            { "type": "function_call_output", "call_id": "orphan_call", "name": "read", "output": "{}" },
        ]));
        let result = normalize_orphaned_tool_outputs(input);
        let content = result[0].content.as_ref().and_then(Value::as_str).unwrap();
        assert_eq!(content, "[Previous read result; call_id=orphan_call]: {}");
    }

    #[test]
    fn normalize_message_label_falls_back_to_tool_and_unknown() {
        // No name → "tool"; blank call_id → "unknown".
        let input = items(json!([
            { "type": "custom_tool_call_output", "call_id": "   ", "output": "oops" },
        ]));
        let result = normalize_orphaned_tool_outputs(input);
        let content = result[0].content.as_ref().and_then(Value::as_str).unwrap();
        assert_eq!(content, "[Previous tool result; call_id=unknown]: oops");
    }

    // --- combined flow -----------------------------------------------------

    #[test]
    fn combined_flow_handles_both_orphaned_calls_and_outputs() {
        let input = items(json!([
            { "type": "function_call_output", "role": "tool", "call_id": "orphan_output", "output": "lost result" },
            { "type": "function_call", "role": "assistant", "call_id": "orphan_call", "name": "new_tool" },
        ]));
        let normalized = normalize_orphaned_tool_outputs(input);
        let injected = inject_missing_tool_outputs(normalized);
        assert_eq!(
            injected
                .iter()
                .filter(|i| i.kind.as_deref() == Some("message"))
                .count(),
            1
        );
        assert_eq!(
            injected
                .iter()
                .filter(|i| i.kind.as_deref() == Some("function_call"))
                .count(),
            1
        );
        assert_eq!(
            injected
                .iter()
                .filter(|i| i.kind.as_deref() == Some("function_call_output"))
                .count(),
            1
        );
    }

    // --- getContentText edge cases -----------------------------------------

    #[test]
    fn get_content_text_returns_empty_for_non_string_non_array_content() {
        assert_eq!(
            get_content_text(&item(json!({ "type": "message", "role": "user" }))),
            ""
        );
        assert_eq!(
            get_content_text(&item(
                json!({ "type": "message", "role": "user", "content": null })
            )),
            ""
        );
        assert_eq!(
            get_content_text(&item(
                json!({ "type": "message", "role": "user", "content": 123 })
            )),
            ""
        );
    }

    #[test]
    fn get_content_text_joins_input_text_parts_and_skips_empty_or_foreign_parts() {
        let value = item(json!({
            "type": "message",
            "role": "user",
            "content": [
                { "type": "input_text", "text": "one" },
                { "type": "input_image", "url": "x" },
                { "type": "input_text", "text": "" },
                { "type": "input_text", "text": "two" },
            ]
        }));
        assert_eq!(get_content_text(&value), "one\ntwo");
    }

    // --- isHostSystemPrompt -------------------------------------------------

    #[test]
    fn host_prompt_true_when_content_starts_with_cached_prompt() {
        let cached = "You are Codex, an agent";
        let value = item(json!({
            "type": "message",
            "role": "system",
            "content": "You are Codex, an agent with additional context appended here",
        }));
        assert!(is_host_system_prompt(&value, Some(cached)));
    }

    #[test]
    fn host_prompt_true_when_first_200_chars_match_cached_prefix() {
        let long_text = "A".repeat(250);
        let content = format!("{}{}", &long_text[..200], "B".repeat(100));
        let value = item(json!({
            "type": "message",
            "role": "system",
            "content": content,
        }));
        assert!(is_host_system_prompt(&value, Some(&long_text)));
    }

    #[test]
    fn host_prompt_false_for_non_system_roles_even_with_matching_content() {
        let value = item(json!({
            "type": "message",
            "role": "user",
            "content": "You are Codex, an agent",
        }));
        assert!(!is_host_system_prompt(
            &value,
            Some("You are Codex, an agent")
        ));
    }

    #[test]
    fn host_prompt_false_when_content_is_empty() {
        let value = item(json!({
            "type": "message",
            "role": "system",
            "content": "",
        }));
        assert!(!is_host_system_prompt(
            &value,
            Some("You are Codex, an agent")
        ));
    }

    #[test]
    fn host_prompt_true_for_developer_role_with_matching_signature() {
        let value = item(json!({
            "type": "message",
            "role": "developer",
            "content": "You are Codex, an interactive CLI agent that does stuff",
        }));
        assert!(is_host_system_prompt(&value, None));
    }

    #[test]
    fn host_prompt_detects_string_and_array_content_signatures() {
        let string_item = item(json!({
            "type": "message",
            "role": "developer",
            "content": "You are a coding agent running in the Codex, a terminal-based coding assistant.",
        }));
        assert!(is_host_system_prompt(&string_item, None));

        let array_item = item(json!({
            "type": "message",
            "role": "developer",
            "content": [{
                "type": "input_text",
                "text": "You are a coding agent running in the Codex, a terminal-based coding assistant.",
            }],
        }));
        assert!(is_host_system_prompt(&array_item, None));
    }

    #[test]
    fn host_prompt_does_not_detect_agents_md_or_env_content() {
        let agents_md = item(json!({
            "type": "message",
            "role": "developer",
            "content": "# Project Guidelines\n\nThis is custom AGENTS.md content for the project.",
        }));
        assert!(!is_host_system_prompt(&agents_md, None));

        let env_plus_agents = item(json!({
            "type": "message",
            "role": "developer",
            "content": "Environment: /path/to/project\nDate: 2025-01-01\n\n# AGENTS.md\n\nCustom instructions here.",
        }));
        assert!(!is_host_system_prompt(&env_plus_agents, None));
    }

    #[test]
    fn host_prompt_does_not_detect_signature_in_the_middle() {
        let cached = "You are a coding agent running in the Codex.";
        let value = item(json!({
            "type": "message",
            "role": "developer",
            "content": "Environment info here\n\nYou are a coding agent running in the Codex.",
        }));
        assert!(!is_host_system_prompt(&value, Some(cached)));
    }

    // --- filterHostSystemPromptsWithCachedPrompt ---------------------------

    #[test]
    fn filter_returns_none_for_none_input() {
        assert!(filter_host_system_prompts_with_cached_prompt(None, None).is_none());
    }

    #[test]
    fn filter_preserves_user_messages_unchanged() {
        let input = items(json!([
            { "type": "message", "role": "user", "content": "Hello" },
        ]));
        let result = filter_host_system_prompts_with_cached_prompt(Some(input.clone()), None);
        assert_eq!(result, Some(input));
    }

    #[test]
    fn filter_drops_host_system_prompt_without_context() {
        let input = items(json!([
            { "type": "message", "role": "system", "content": "You are Codex, an agent doing things" },
        ]));
        let result = filter_host_system_prompts_with_cached_prompt(Some(input), None).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn filter_preserves_context_when_filtering_host_prompt() {
        let input = items(json!([
            {
                "type": "message",
                "role": "system",
                "content": "You are Codex, an agent\n\nHere is some useful information about the environment you are running in:\n<env>test</env>",
            },
        ]));
        let result = filter_host_system_prompts_with_cached_prompt(Some(input), None).unwrap();
        assert_eq!(result.len(), 1);
        let content = result[0].content.as_ref().and_then(Value::as_str).unwrap();
        assert!(content.contains("Here is some useful information"));
        assert!(!content.contains("You are Codex, an agent\n"));
    }

    #[test]
    fn filter_replaces_array_content_with_extracted_context() {
        let input = items(json!([
            {
                "type": "message",
                "role": "system",
                "content": [
                    { "type": "input_text", "text": "You are Codex, an agent\n\n<instructions>\nDo things</instructions>" },
                ],
            },
        ]));
        let result = filter_host_system_prompts_with_cached_prompt(Some(input), None).unwrap();
        assert_eq!(result.len(), 1);
        let content = result[0].content.as_ref().unwrap();
        let parts = content.as_array().expect("array content stays an array");
        let text = parts[0].get("text").and_then(Value::as_str).unwrap();
        assert!(text.contains("<instructions>"));
    }

    #[test]
    fn filter_keeps_agents_md_and_env_messages() {
        let input = items(json!([
            { "type": "message", "role": "developer", "content": "You are a coding agent running in the Codex" },
            { "type": "message", "role": "developer", "content": "# Project Guidelines\n\nThis is AGENTS.md content." },
            { "type": "message", "role": "user", "content": "hello" },
        ]));
        let result = filter_host_system_prompts_with_cached_prompt(Some(input), None).unwrap();
        assert_eq!(result.len(), 2);
        let first = result[0].content.as_ref().and_then(Value::as_str).unwrap();
        assert!(first.contains("AGENTS.md"));
        assert_eq!(result[1].role.as_deref(), Some("user"));
    }

    #[test]
    fn filter_strips_codex_prompt_but_keeps_concatenated_env_instructions() {
        let content = [
            "You are a coding agent running in the Codex, a terminal-based coding assistant.",
            "Here is some useful information about the environment you are running in:",
            "<env>",
            "  Working directory: /path/to/project",
            "</env>",
            "Instructions from: /path/to/AGENTS.md",
            "# Project Guidelines",
        ]
        .join("\n");
        let input = items(json!([
            { "type": "message", "role": "developer", "content": content },
            { "type": "message", "role": "user", "content": "hello" },
        ]));
        let result = filter_host_system_prompts_with_cached_prompt(Some(input), None).unwrap();
        assert_eq!(result.len(), 2);
        let preserved = result[0].content.as_ref().and_then(Value::as_str).unwrap();
        assert!(preserved.contains("Here is some useful information about the environment"));
        assert!(preserved.contains("Instructions from: /path/to/AGENTS.md"));
        assert!(!preserved.contains("You are a coding agent running in the Codex"));
    }
}
