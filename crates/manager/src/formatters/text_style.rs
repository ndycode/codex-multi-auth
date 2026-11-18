//! Port of `lib/codex-manager/formatters/text-style.ts`.
//!
//! `stylePromptText` reads `process.stdout.isTTY` and the process-global UI
//! runtime options live. To keep every styled formatter testable without a
//! TTY, the styling core is a pure function over a [`StyleContext`]; the
//! TS-named wrappers sample the live environment exactly like the TS module.

use std::io::IsTerminal;

use cma_core::json_io::stringify_compact;
use cma_tui::ansi;
use cma_tui::format::{UiTextTone, paint_ui_text};
use cma_tui::runtime_options::{UiRuntimeOptions, get_ui_runtime_options};
use serde_json::Value;

/// TS `PromptTone = "accent" | "success" | "warning" | "danger" | "muted"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptTone {
    Accent,
    Success,
    Warning,
    Danger,
    Muted,
}

impl PromptTone {
    pub const fn as_str(self) -> &'static str {
        match self {
            PromptTone::Accent => "accent",
            PromptTone::Success => "success",
            PromptTone::Warning => "warning",
            PromptTone::Danger => "danger",
            PromptTone::Muted => "muted",
        }
    }
}

/// The live inputs `stylePromptText` sampled implicitly in TS
/// (`process.stdout.isTTY` + `getUiRuntimeOptions()`), captured explicitly so
/// formatters stay pure functions returning `String` (testable without a TTY).
#[derive(Clone, Debug)]
pub struct StyleContext {
    pub ui: UiRuntimeOptions,
    pub is_tty: bool,
}

impl StyleContext {
    /// Sample the live process state (what the TS module did on every call).
    pub fn live() -> Self {
        StyleContext {
            ui: get_ui_runtime_options(),
            is_tty: std::io::stdout().is_terminal(),
        }
    }

    pub fn new(ui: UiRuntimeOptions, is_tty: bool) -> Self {
        StyleContext { ui, is_tty }
    }
}

/// TS `stylePromptText(text, tone)` over an explicit context.
pub fn style_prompt_text_with(ctx: &StyleContext, text: &str, tone: PromptTone) -> String {
    if !ctx.is_tty {
        return text.to_string();
    }
    let ui = &ctx.ui;
    if ui.v2_enabled {
        if tone == PromptTone::Muted {
            return format!(
                "{}{}{}",
                ui.theme.colors.dim,
                paint_ui_text(ui, text, UiTextTone::Muted),
                ui.theme.colors.reset
            );
        }
        let mapped = match tone {
            PromptTone::Accent => UiTextTone::Primary,
            PromptTone::Success => UiTextTone::Success,
            PromptTone::Warning => UiTextTone::Warning,
            PromptTone::Danger => UiTextTone::Danger,
            // Handled above; kept exhaustive for the compiler.
            PromptTone::Muted => UiTextTone::Muted,
        };
        return paint_ui_text(ui, text, mapped);
    }
    let legacy_code = match tone {
        PromptTone::Accent | PromptTone::Success => ansi::GREEN,
        PromptTone::Warning => ansi::YELLOW,
        PromptTone::Danger => ansi::RED,
        PromptTone::Muted => ansi::DIM,
    };
    format!("{legacy_code}{text}{}", ansi::RESET)
}

/// TS `stylePromptText(text, tone)` — live stdout-TTY + UI runtime sampling.
pub fn style_prompt_text(text: &str, tone: PromptTone) -> String {
    style_prompt_text_with(&StyleContext::live(), text, tone)
}

/// JS `\s` includes U+FEFF, which Rust's `char::is_whitespace` does not.
fn is_js_whitespace(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// TS `collapseWhitespace(value)` — `value.replace(/\s+/g, " ").trim()`.
pub fn collapse_whitespace(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_run = false;
    for c in value.chars() {
        if is_js_whitespace(c) {
            if !in_run {
                out.push(' ');
                in_run = true;
            }
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out.trim_matches(' ').to_string()
}

/// TS `formatReasonLabel(reason)` — `_` → space, collapse, `None` when empty.
pub fn format_reason_label(reason: Option<&str>) -> Option<String> {
    let reason = reason?;
    if reason.is_empty() {
        return None;
    }
    let normalized = collapse_whitespace(&reason.replace('_', " "));
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// TS `extractErrorMessageFromPayload(payload)`.
pub fn extract_error_message_from_payload(payload: &Value) -> Option<String> {
    let record = payload.as_object()?;

    let direct_message = record
        .get("message")
        .and_then(Value::as_str)
        .map(collapse_whitespace)
        .unwrap_or_default();
    let direct_code = record
        .get("code")
        .and_then(Value::as_str)
        .map(collapse_whitespace)
        .unwrap_or_default();
    if !direct_message.is_empty() {
        if !direct_code.is_empty()
            && !direct_message
                .to_lowercase()
                .contains(&direct_code.to_lowercase())
        {
            return Some(format!("{direct_message} [{direct_code}]"));
        }
        return Some(direct_message);
    }

    match record.get("error") {
        Some(nested) if nested.is_object() => extract_error_message_from_payload(nested),
        _ => None,
    }
}

/// TS `parseStructuredErrorMessage(raw)` — try the trimmed string and the
/// first `{` … last `}` slice as JSON, returning the first payload message.
pub fn parse_structured_error_message(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut candidates: Vec<&str> = vec![trimmed];
    if let (Some(first_brace), Some(last_brace)) = (trimmed.find('{'), trimmed.rfind('}'))
        && last_brace > first_brace
    {
        let slice = &trimmed[first_brace..=last_brace];
        if slice != trimmed {
            candidates.push(slice);
        }
    }

    for candidate in candidates {
        if let Ok(parsed) = serde_json::from_str::<Value>(candidate)
            && let Some(message) = extract_error_message_from_payload(&parsed)
        {
            return Some(message);
        }
    }
    None
}

/// TS `normalizeFailureDetail(message, reason)`.
///
/// Length bound: the TS `.length`/`.slice` operate on UTF-16 units; this port
/// counts Unicode scalar values (identical for the ASCII detail strings that
/// actually flow through here).
pub fn normalize_failure_detail(message: Option<&str>, reason: Option<&str>) -> String {
    let reason_label = format_reason_label(reason);
    let trimmed_message = message.map(str::trim).unwrap_or_default();
    let raw: String = if !trimmed_message.is_empty() {
        trimmed_message.to_string()
    } else if let Some(label) = reason_label {
        label
    } else {
        "refresh failed".to_string()
    };
    let structured = parse_structured_error_message(&raw);
    let normalized = collapse_whitespace(structured.as_deref().unwrap_or(&raw));
    let char_count = normalized.chars().count();
    let bounded = if char_count > 260 {
        let prefix: String = normalized.chars().take(257).collect();
        format!("{prefix}...")
    } else {
        normalized
    };
    if bounded.is_empty() {
        "refresh failed".to_string()
    } else {
        bounded
    }
}

/// TS `joinStyledSegments(parts)` over an explicit context.
pub fn join_styled_segments_with(ctx: &StyleContext, parts: &[String]) -> String {
    if parts.is_empty() {
        return String::new();
    }
    let separator = style_prompt_text_with(ctx, " | ", PromptTone::Muted);
    parts.join(&separator)
}

/// TS `joinStyledSegments(parts)` — live context.
pub fn join_styled_segments(parts: &[String]) -> String {
    join_styled_segments_with(&StyleContext::live(), parts)
}

/// One `formatResultSummary` segment (TS `{ text, tone }`).
#[derive(Clone, Debug)]
pub struct ResultSegment {
    pub text: String,
    pub tone: PromptTone,
}

impl ResultSegment {
    pub fn new(text: impl Into<String>, tone: PromptTone) -> Self {
        ResultSegment {
            text: text.into(),
            tone,
        }
    }
}

/// TS `formatResultSummary(segments)` over an explicit context.
pub fn format_result_summary_with(ctx: &StyleContext, segments: &[ResultSegment]) -> String {
    let rendered: Vec<String> = segments
        .iter()
        .map(|segment| style_prompt_text_with(ctx, &segment.text, segment.tone))
        .collect();
    format!(
        "{} {}",
        style_prompt_text_with(ctx, "Result:", PromptTone::Accent),
        join_styled_segments_with(ctx, &rendered)
    )
}

/// TS `formatResultSummary(segments)` — live context.
pub fn format_result_summary(segments: &[ResultSegment]) -> String {
    format_result_summary_with(&StyleContext::live(), segments)
}

/// TS `stringifyLogArgs(args)` — strings pass through raw, everything else is
/// `JSON.stringify`-ed. (The TS cyclic-object fallback to `String(value)` is
/// unreachable here: `serde_json::Value` cannot be cyclic.)
pub fn stringify_log_args(args: &[Value]) -> String {
    args.iter()
        .map(|value| match value {
            Value::String(s) => s.clone(),
            other => stringify_compact(other),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_tui::runtime_options::{
        UiRuntimeOptionsPatch, reset_ui_runtime_options, set_ui_runtime_options,
    };
    use serde_json::json;
    use serial_test::serial;

    fn plain_ctx() -> StyleContext {
        // Non-TTY: stylePromptText is a passthrough, matching the vitest runs.
        StyleContext::new(get_ui_runtime_options(), false)
    }

    // Ported from test/codex-manager-formatters.test.ts ("text-style formatters").

    #[test]
    fn collapse_whitespace_flattens_runs_and_trims() {
        assert_eq!(collapse_whitespace("  a\t\n b   c "), "a b c");
        assert_eq!(collapse_whitespace("\n\t "), "");
    }

    #[test]
    fn format_reason_label_humanizes_snake_case_and_drops_empties() {
        assert_eq!(
            format_reason_label(Some("invalid_grant")).as_deref(),
            Some("invalid grant")
        );
        assert_eq!(
            format_reason_label(Some("  rate__limited  ")).as_deref(),
            Some("rate limited")
        );
        assert_eq!(format_reason_label(Some("")), None);
        assert_eq!(format_reason_label(None), None);
        assert_eq!(format_reason_label(Some("___")), None);
    }

    #[test]
    fn extract_error_message_reads_direct_coded_and_nested_shapes() {
        assert_eq!(
            extract_error_message_from_payload(&json!({"message": "token  expired"})).as_deref(),
            Some("token expired")
        );
        assert_eq!(
            extract_error_message_from_payload(
                &json!({"message": "token expired", "code": "invalid_grant"})
            )
            .as_deref(),
            Some("token expired [invalid_grant]")
        );
        assert_eq!(
            extract_error_message_from_payload(
                &json!({"message": "Invalid_Grant: token expired", "code": "invalid_grant"})
            )
            .as_deref(),
            Some("Invalid_Grant: token expired")
        );
        assert_eq!(
            extract_error_message_from_payload(
                &json!({"error": {"error": {"message": "deeply nested"}}})
            )
            .as_deref(),
            Some("deeply nested")
        );
        assert_eq!(extract_error_message_from_payload(&Value::Null), None);
        assert_eq!(extract_error_message_from_payload(&json!("string")), None);
        assert_eq!(
            extract_error_message_from_payload(&json!({"code": "only_code"})),
            None
        );
    }

    #[test]
    fn parse_structured_error_message_finds_json_embedded_in_prose() {
        assert_eq!(
            parse_structured_error_message("{\"error\":{\"message\":\"quota hit\"}}").as_deref(),
            Some("quota hit")
        );
        assert_eq!(
            parse_structured_error_message(
                "refresh failed: {\"message\":\"server says no\"} (status 400)"
            )
            .as_deref(),
            Some("server says no")
        );
        assert_eq!(parse_structured_error_message("plain text failure"), None);
        assert_eq!(parse_structured_error_message("   "), None);
    }

    #[test]
    fn normalize_failure_detail_prefers_message_falls_back_and_bounds() {
        assert_eq!(
            normalize_failure_detail(Some("boom"), Some("invalid_grant")),
            "boom"
        );
        assert_eq!(
            normalize_failure_detail(None, Some("invalid_grant")),
            "invalid grant"
        );
        assert_eq!(normalize_failure_detail(None, None), "refresh failed");
        assert_eq!(
            normalize_failure_detail(Some("  "), Some("")),
            "refresh failed"
        );
        assert_eq!(
            normalize_failure_detail(Some("{\"error\":{\"message\":\"unwrapped\"}}"), None),
            "unwrapped"
        );
        let long = "x".repeat(300);
        let bounded = normalize_failure_detail(Some(&long), None);
        assert_eq!(bounded.chars().count(), 260);
        assert!(bounded.ends_with("..."));
    }

    #[test]
    #[serial]
    fn join_and_result_summary_render_plain_in_non_tty() {
        let ctx = plain_ctx();
        assert_eq!(join_styled_segments_with(&ctx, &[]), "");
        assert_eq!(
            join_styled_segments_with(&ctx, &["a".to_string(), "b".to_string()]),
            "a | b"
        );
        assert_eq!(
            format_result_summary_with(
                &ctx,
                &[
                    ResultSegment::new("saved", PromptTone::Success),
                    ResultSegment::new("synced", PromptTone::Muted),
                ]
            ),
            "Result: saved | synced"
        );
    }

    #[test]
    fn stringify_log_args_serializes_mixed_args() {
        assert_eq!(
            stringify_log_args(&[json!("msg"), json!({"a": 1})]),
            "msg {\"a\":1}"
        );
    }

    #[test]
    #[serial]
    fn legacy_tones_use_exact_ansi_codes_on_tty() {
        let ui = set_ui_runtime_options(UiRuntimeOptionsPatch {
            v2_enabled: Some(false),
            ..Default::default()
        });
        let ctx = StyleContext::new(ui, true);
        assert_eq!(
            style_prompt_text_with(&ctx, "x", PromptTone::Danger),
            format!("{}x{}", ansi::RED, ansi::RESET)
        );
        assert_eq!(
            style_prompt_text_with(&ctx, "x", PromptTone::Warning),
            format!("{}x{}", ansi::YELLOW, ansi::RESET)
        );
        assert_eq!(
            style_prompt_text_with(&ctx, "x", PromptTone::Accent),
            format!("{}x{}", ansi::GREEN, ansi::RESET)
        );
        assert_eq!(
            style_prompt_text_with(&ctx, "x", PromptTone::Success),
            format!("{}x{}", ansi::GREEN, ansi::RESET)
        );
        assert_eq!(
            style_prompt_text_with(&ctx, "x", PromptTone::Muted),
            format!("{}x{}", ansi::DIM, ansi::RESET)
        );
        reset_ui_runtime_options();
    }
}
