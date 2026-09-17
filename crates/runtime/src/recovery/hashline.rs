//! Port of `lib/tools/hashline-tools.ts` — the PURE hashline edit engine
//! (spec 11 §4, R2: library-only).
//!
//! The TS module also registers two host plugin tools
//! (`createHashlineReadTool` / `createHashlineEditTool`); those wrap the pure
//! engine with host permission prompts and file I/O and only make sense
//! inside the JS host, so they are NOT ported (R2). Everything the tools
//! compute — hashes, refs, window rendering, legacy + hashline edits,
//! updated-ref blocks — lives here.
//!
//! Byte-exactness model (gotcha 26): hashes are the first 8 hex chars of
//! sha1 over the LF-normalized line text; edits preserve the file's original
//! CRLF/LF convention and trailing-newline state (mixed line endings collapse
//! to CRLF if any CRLF is present); errors are returned as strings, never
//! panics.

use sha1::{Digest, Sha1};

/// TS `DEFAULT_WINDOW_LINES`.
pub const DEFAULT_WINDOW_LINES: i64 = 120;
/// TS `MAX_WINDOW_LINES`.
pub const MAX_WINDOW_LINES: i64 = 400;
/// TS `LINE_PREVIEW_LIMIT` (clip >240 chars → 237 + `"..."`).
pub const LINE_PREVIEW_LIMIT: usize = 240;

/// TS `HashlineOperation`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HashlineOperation {
    Replace,
    InsertBefore,
    InsertAfter,
    Delete,
}

impl HashlineOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Replace => "replace",
            Self::InsertBefore => "insert_before",
            Self::InsertAfter => "insert_after",
            Self::Delete => "delete",
        }
    }
}

/// TS `ParsedHashlineRef`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedHashlineRef {
    /// 1-based line number (regex `[1-9]\d*` — never 0).
    pub line_number: usize,
    /// Lowercased 8-hex hash.
    pub hash: String,
    /// The trimmed input as given.
    pub raw: String,
}

/// Normalized file text (TS private `NormalizedFileText`).
#[derive(Clone, Debug, PartialEq, Eq)]
struct NormalizedFileText {
    lines: Vec<String>,
    eol: &'static str,
    had_trailing_newline: bool,
}

/// TS `HashlineEditSuccess` (the `ok: true` arm).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HashlineEditSuccess {
    pub updated_content: String,
    pub operation: HashlineOperation,
    /// 1-based changed range for updated-ref rendering.
    pub changed_start_line: usize,
    pub changed_end_line: usize,
}

/// TS `LegacyEditSuccess` (the `ok: true` arm).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyEditSuccess {
    pub updated_content: String,
    pub replacements: usize,
}

/// TS `HashlineEditArgs`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HashlineEditArgs {
    pub line_ref: Option<String>,
    pub end_line_ref: Option<String>,
    pub operation: Option<String>,
    pub content: Option<String>,
    pub new_string: Option<String>,
}

/// TS `LegacyEditArgs`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LegacyEditArgs {
    pub old_string: Option<String>,
    pub new_string: Option<String>,
    pub replace_all: bool,
}

// =============================================================================
// Text normalization
// =============================================================================

fn normalize_file_text(content: &str) -> NormalizedFileText {
    let normalized = content.replace("\r\n", "\n");
    let eol = if content.contains("\r\n") { "\r\n" } else { "\n" };
    if normalized.is_empty() {
        return NormalizedFileText {
            lines: Vec::new(),
            eol,
            had_trailing_newline: false,
        };
    }

    let had_trailing_newline = normalized.ends_with('\n');
    let mut lines: Vec<String> = normalized.split('\n').map(str::to_string).collect();
    if had_trailing_newline {
        lines.pop();
    }

    NormalizedFileText {
        lines,
        eol,
        had_trailing_newline,
    }
}

fn denormalize_file_text(value: &NormalizedFileText) -> String {
    if value.lines.is_empty() {
        return String::new();
    }
    let joined = value.lines.join(value.eol);
    if value.had_trailing_newline {
        format!("{joined}{}", value.eol)
    } else {
        joined
    }
}

fn split_insert_text(value: &str) -> Vec<String> {
    let normalized = value.replace("\r\n", "\n");
    if normalized.is_empty() {
        return Vec::new();
    }
    let trailing = normalized.ends_with('\n');
    let mut lines: Vec<String> = normalized.split('\n').map(str::to_string).collect();
    if trailing {
        lines.pop();
    }
    lines
}

/// Clip a line for previews (TS `clipLine` — chars, JS UTF-16 semantics
/// approximated with Unicode scalar values).
fn clip_line(text: &str) -> String {
    let count = text.chars().count();
    if count <= LINE_PREVIEW_LIMIT {
        return text.to_string();
    }
    let head: String = text.chars().take(LINE_PREVIEW_LIMIT - 3).collect();
    format!("{head}...")
}

// =============================================================================
// Legacy placeholder detection
// =============================================================================

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_placeholder_class_char(c: char) -> bool {
    c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'
}

/// Word-boundary token search inside a placeholder body (hand-rolled
/// equivalent of `\b(?:TARGET_[A-Z0-9_]*|ORIGINAL_LINES|SNIPPET|START_LINE|END_LINE)\b`).
fn contains_placeholder_token(inner: &str) -> bool {
    let chars: Vec<char> = inner.chars().collect();
    let candidates: [&str; 4] = ["ORIGINAL_LINES", "SNIPPET", "START_LINE", "END_LINE"];

    for start in 0..chars.len() {
        // \b before the token.
        if start > 0 && is_word_char(chars[start - 1]) {
            continue;
        }
        let rest: String = chars[start..].iter().collect();

        // TARGET_[A-Z0-9_]* with \b after the maximal class run.
        if rest.starts_with("TARGET_") {
            let mut end = start + "TARGET_".len();
            while end < chars.len() && is_placeholder_class_char(chars[end]) {
                end += 1;
            }
            if end >= chars.len() || !is_word_char(chars[end]) {
                return true;
            }
        }

        for token in candidates {
            if rest.starts_with(token) {
                let end = start + token.chars().count();
                if end >= chars.len() || !is_word_char(chars[end]) {
                    return true;
                }
            }
        }
    }
    false
}

/// TS `findUnresolvedLegacyPlaceholder` — the full `${...}` match, if any.
fn find_unresolved_legacy_placeholder(value: &str) -> Option<String> {
    let bytes: Vec<char> = value.chars().collect();
    let mut i = 0usize;
    while i + 1 < bytes.len() {
        if bytes[i] == '$' && bytes[i + 1] == '{' {
            // Regex `[^}]*\}`: the body runs to the next `}`.
            if let Some(close_offset) = bytes[i + 2..].iter().position(|&c| c == '}') {
                let inner: String = bytes[i + 2..i + 2 + close_offset].iter().collect();
                if contains_placeholder_token(&inner) {
                    let full: String = bytes[i..=i + 2 + close_offset].iter().collect();
                    return Some(full);
                }
            }
        }
        i += 1;
    }
    None
}

// =============================================================================
// Pure exports
// =============================================================================

/// TS `computeHashline(text)` — first 8 hex chars of sha1(utf8 text).
pub fn compute_hashline(text: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(text.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..8].to_string()
}

/// TS `formatHashlineRef(lineNumber, text)` — `L{n}#{hash}`.
pub fn format_hashline_ref(line_number: usize, text: &str) -> String {
    format!("L{line_number}#{}", compute_hashline(text))
}

/// TS `parseHashlineRef(value)` — `/^L([1-9]\d*)#([a-f0-9]{8})$/i`.
pub fn parse_hashline_ref(value: &str) -> Option<ParsedHashlineRef> {
    let raw = value.trim();
    let mut chars = raw.chars();
    match chars.next() {
        Some('L') | Some('l') => {}
        _ => return None,
    }
    let rest: &str = chars.as_str();
    let hash_sep = rest.find('#')?;
    let digits = &rest[..hash_sep];
    let hash_part = &rest[hash_sep + 1..];

    if digits.is_empty() || !digits.starts_with(|c: char| ('1'..='9').contains(&c)) {
        return None;
    }
    if !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if hash_part.chars().count() != 8 || !hash_part.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }

    // JS parseInt tolerates arbitrarily large values (as floats); a line
    // number that overflows usize could never be in range anyway, so the
    // Rust port treats overflow as unparseable (recorded deviation).
    let line_number: usize = digits.parse().ok()?;
    if line_number < 1 {
        return None;
    }

    Some(ParsedHashlineRef {
        line_number,
        hash: hash_part.to_lowercase(),
        raw: raw.to_string(),
    })
}

/// TS `renderHashlineSlice(content, startLine = 1, maxLines = 120)`.
pub fn render_hashline_slice(content: &str, start_line: i64, max_lines: i64) -> String {
    let normalized = normalize_file_text(content);
    if normalized.lines.is_empty() {
        return "File is empty.".to_string();
    }

    let total = normalized.lines.len();
    let safe_start_line = start_line.max(1) as usize;
    let safe_max_lines = max_lines.clamp(1, MAX_WINDOW_LINES) as usize;
    let start_index = (total - 1).min(safe_start_line - 1);
    let end_index = (total - 1).min(start_index + safe_max_lines - 1);

    let mut lines: Vec<String> = vec![
        format!(
            "Hashline window {}-{} of {}:",
            start_index + 1,
            end_index + 1,
            total
        ),
        String::new(),
    ];

    for index in start_index..=end_index {
        let line_text = &normalized.lines[index];
        lines.push(format!(
            "{} | {}",
            format_hashline_ref(index + 1, line_text),
            clip_line(line_text)
        ));
    }

    if end_index < total - 1 {
        lines.push(String::new());
        lines.push(format!("... {} more line(s).", total - end_index - 1));
    }

    lines.join("\n")
}

/// TS `applyLegacyEdit(content, args)`.
pub fn apply_legacy_edit(content: &str, args: &LegacyEditArgs) -> Result<LegacyEditSuccess, String> {
    let Some(old_string) = args.old_string.as_deref().filter(|s| !s.is_empty()) else {
        return Err(
            "Legacy edit requires non-empty oldString. For hashline mode, use lineRef."
                .to_string(),
        );
    };

    if let Some(placeholder) = find_unresolved_legacy_placeholder(old_string) {
        return Err(format!(
            "oldString contains unresolved template placeholder {placeholder}. \
Use literal file text for oldString, or prefer hashline_read + lineRef/endLineRef."
        ));
    }

    let new_string = args.new_string.as_deref().unwrap_or("");
    if args.replace_all {
        let parts: Vec<&str> = content.split(old_string).collect();
        let replacements = parts.len() - 1;
        if replacements == 0 {
            return Err("oldString not found.".to_string());
        }
        return Ok(LegacyEditSuccess {
            updated_content: parts.join(new_string),
            replacements,
        });
    }

    let Some(first_index) = content.find(old_string) else {
        return Err("oldString not found.".to_string());
    };

    if content[first_index + old_string.len()..].contains(old_string) {
        return Err(
            "oldString appears multiple times. Use replaceAll=true or hashline mode.".to_string(),
        );
    }

    let updated_content = format!(
        "{}{}{}",
        &content[..first_index],
        new_string,
        &content[first_index + old_string.len()..]
    );
    Ok(LegacyEditSuccess {
        updated_content,
        replacements: 1,
    })
}

fn parse_operation(value: Option<&str>) -> Option<HashlineOperation> {
    let normalized = value.unwrap_or("replace").trim().to_lowercase();
    match normalized.as_str() {
        "replace" => Some(HashlineOperation::Replace),
        "insert_before" => Some(HashlineOperation::InsertBefore),
        "insert_after" => Some(HashlineOperation::InsertAfter),
        "delete" => Some(HashlineOperation::Delete),
        _ => None,
    }
}

/// TS private `resolveHashlineRef` — 0-based index or the exact error text.
fn resolve_hashline_ref(
    lines: &[String],
    r: &ParsedHashlineRef,
    label: &str,
) -> Result<usize, String> {
    if r.line_number > lines.len() {
        return Err(format!(
            "{label} is out of range ({}). File has {} line(s).",
            r.raw,
            lines.len()
        ));
    }
    let index = r.line_number - 1;
    let line = &lines[index];
    let current_hash = compute_hashline(line);
    if current_hash != r.hash {
        return Err(format!(
            "{label} hash mismatch at line {}. Expected {}, found {current_hash}. Current ref: {}",
            r.line_number,
            r.hash,
            format_hashline_ref(r.line_number, line)
        ));
    }
    Ok(index)
}

/// TS `applyHashlineEdit(content, args)`.
pub fn apply_hashline_edit(
    content: &str,
    args: &HashlineEditArgs,
) -> Result<HashlineEditSuccess, String> {
    let Some(line_ref_raw) = args.line_ref.as_deref() else {
        return Err("lineRef is required for hashline edit mode.".to_string());
    };

    let Some(line_ref) = parse_hashline_ref(line_ref_raw) else {
        return Err(format!(
            "Invalid lineRef format: {line_ref_raw}. Expected L<line>#<hash>."
        ));
    };

    let end_line_ref = match args.end_line_ref.as_deref() {
        Some(raw) => match parse_hashline_ref(raw) {
            Some(parsed) => parsed,
            None => {
                return Err(format!(
                    "Invalid endLineRef format: {raw}. Expected L<line>#<hash>."
                ));
            }
        },
        None => line_ref.clone(),
    };

    if end_line_ref.line_number < line_ref.line_number {
        return Err("endLineRef must be on or after lineRef.".to_string());
    }

    let Some(operation) = parse_operation(args.operation.as_deref()) else {
        return Err(
            "Invalid operation. Use one of: replace, insert_before, insert_after, delete."
                .to_string(),
        );
    };

    let normalized = normalize_file_text(content);
    let mut lines = normalized.lines.clone();

    let start_index = resolve_hashline_ref(&lines, &line_ref, "lineRef")?;
    let end_index = resolve_hashline_ref(&lines, &end_line_ref, "endLineRef")?;

    let range_length = end_index - start_index + 1;
    let next_text = args
        .content
        .as_deref()
        .or(args.new_string.as_deref())
        .unwrap_or("");
    let insert_lines = split_insert_text(next_text);

    if matches!(
        operation,
        HashlineOperation::InsertBefore | HashlineOperation::InsertAfter
    ) && insert_lines.is_empty()
    {
        return Err(format!("content is required for {}.", operation.as_str()));
    }

    let changed_start_line: usize;
    let changed_end_line: usize;

    match operation {
        HashlineOperation::Replace => {
            lines.splice(start_index..start_index + range_length, insert_lines.clone());
            changed_start_line = line_ref.line_number;
            changed_end_line = if !insert_lines.is_empty() {
                line_ref.line_number + insert_lines.len() - 1
            } else {
                1.max(line_ref.line_number.saturating_sub(1))
            };
        }
        HashlineOperation::Delete => {
            lines.splice(start_index..start_index + range_length, Vec::new());
            changed_start_line = 1.max(line_ref.line_number.saturating_sub(1));
            changed_end_line = changed_start_line;
        }
        HashlineOperation::InsertBefore => {
            lines.splice(start_index..start_index, insert_lines.clone());
            changed_start_line = line_ref.line_number;
            changed_end_line = line_ref.line_number + insert_lines.len() - 1;
        }
        HashlineOperation::InsertAfter => {
            lines.splice(start_index + 1..start_index + 1, insert_lines.clone());
            changed_start_line = line_ref.line_number + 1;
            changed_end_line = line_ref.line_number + insert_lines.len();
        }
    }

    let updated_content = denormalize_file_text(&NormalizedFileText {
        had_trailing_newline: if lines.is_empty() {
            false
        } else {
            normalized.had_trailing_newline
        },
        lines,
        eol: normalized.eol,
    });

    Ok(HashlineEditSuccess {
        updated_content,
        operation,
        changed_start_line,
        changed_end_line,
    })
}

/// TS private `buildUpdatedRefs` — `"{ref} | {clipped}"` lines for the
/// changed range, clamped into the updated content. Public in Rust so a
/// future host-tool layer can reproduce the edit-tool output verbatim.
pub fn build_updated_refs(content: &str, start_line: usize, end_line: usize) -> Vec<String> {
    let normalized = normalize_file_text(content);
    if normalized.lines.is_empty() {
        return Vec::new();
    }
    let total = normalized.lines.len();
    let safe_start = start_line.clamp(1, total);
    let safe_end = safe_start.max(end_line.min(total));

    let mut refs = Vec::new();
    for line_number in safe_start..=safe_end {
        let line = &normalized.lines[line_number - 1];
        refs.push(format!(
            "{} | {}",
            format_hashline_ref(line_number, line),
            clip_line(line)
        ));
    }
    refs
}

// =============================================================================
// Tests — ported from test/hashline-tools.test.ts (pure-engine cases)
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_stable_8_char_hashes() {
        let hash_a = compute_hashline("alpha");
        let hash_b = compute_hashline("alpha");
        let hash_c = compute_hashline("beta");
        assert_eq!(hash_a.len(), 8);
        assert_eq!(hash_a, hash_b);
        assert_ne!(hash_a, hash_c);
    }

    #[test]
    fn formats_and_parses_hashline_refs() {
        let r = format_hashline_ref(7, "example line");
        let parsed = parse_hashline_ref(&r).expect("parses");
        assert_eq!(parsed.line_number, 7);
        assert_eq!(parsed.hash, compute_hashline("example line"));
    }

    #[test]
    fn rejects_malformed_refs() {
        assert!(parse_hashline_ref("7#abcdef12").is_none());
        assert!(parse_hashline_ref("L0#abcdef12").is_none());
        assert!(parse_hashline_ref("L2#xyz").is_none());
        // Case-insensitive hash + leading 'l' accepted; hash lowercased.
        let parsed = parse_hashline_ref(" l3#ABCDEF12 ").expect("parses");
        assert_eq!(parsed.line_number, 3);
        assert_eq!(parsed.hash, "abcdef12");
        assert_eq!(parsed.raw, "l3#ABCDEF12");
    }

    #[test]
    fn renders_hashline_slices_with_refs() {
        let content = "alpha\nbeta\ngamma\n";
        let rendered = render_hashline_slice(content, 2, 2);
        assert!(rendered.contains("Hashline window 2-3 of 3"));
        assert!(rendered.contains(&format!("{} | beta", format_hashline_ref(2, "beta"))));
        assert!(rendered.contains(&format!("{} | gamma", format_hashline_ref(3, "gamma"))));
        assert_eq!(render_hashline_slice("", 1, 10), "File is empty.");

        // Truncation trailer.
        let long = "a\nb\nc\nd\n";
        let rendered = render_hashline_slice(long, 1, 2);
        assert!(rendered.ends_with("... 2 more line(s)."));
    }

    #[test]
    fn applies_legacy_edit_replacement() {
        let result = apply_legacy_edit(
            "one two one",
            &LegacyEditArgs {
                old_string: Some("one".into()),
                new_string: Some("ONE".into()),
                replace_all: true,
            },
        )
        .expect("ok");
        assert_eq!(result.updated_content, "ONE two ONE");
        assert_eq!(result.replacements, 2);
    }

    #[test]
    fn rejects_ambiguous_legacy_edits_without_replace_all() {
        let err = apply_legacy_edit(
            "one two one",
            &LegacyEditArgs {
                old_string: Some("one".into()),
                new_string: Some("ONE".into()),
                replace_all: false,
            },
        )
        .unwrap_err();
        assert!(err.contains("multiple"));
    }

    #[test]
    fn legacy_edit_error_strings_are_exact() {
        let err = apply_legacy_edit("x", &LegacyEditArgs::default()).unwrap_err();
        assert_eq!(
            err,
            "Legacy edit requires non-empty oldString. For hashline mode, use lineRef."
        );
        let err = apply_legacy_edit(
            "x",
            &LegacyEditArgs {
                old_string: Some("missing".into()),
                ..LegacyEditArgs::default()
            },
        )
        .unwrap_err();
        assert_eq!(err, "oldString not found.");
    }

    #[test]
    fn rejects_unresolved_template_placeholders() {
        let err = apply_legacy_edit(
            "alpha\nbeta\n",
            &LegacyEditArgs {
                old_string: Some("${TARGET_SNIPPET}".into()),
                new_string: Some("beta".into()),
                replace_all: false,
            },
        )
        .unwrap_err();
        assert!(err.contains("unresolved template placeholder"));
        assert!(err.contains("hashline_read"));
        assert!(err.contains("${TARGET_SNIPPET}"));
    }

    #[test]
    fn allows_normal_template_literal_fragments() {
        let result = apply_legacy_edit(
            "const message = `hello ${name}`;\n",
            &LegacyEditArgs {
                old_string: Some("${name}".into()),
                new_string: Some("${userName}".into()),
                replace_all: false,
            },
        )
        .expect("ok");
        assert_eq!(result.updated_content, "const message = `hello ${userName}`;\n");
        assert_eq!(result.replacements, 1);
    }

    #[test]
    fn applies_hashline_replace_with_hash_verification() {
        let content = "alpha\nbeta\ngamma\n";
        let line_ref = format_hashline_ref(2, "beta");
        let result = apply_hashline_edit(
            content,
            &HashlineEditArgs {
                line_ref: Some(line_ref),
                operation: Some("replace".into()),
                content: Some("BETA".into()),
                ..HashlineEditArgs::default()
            },
        )
        .expect("ok");
        assert_eq!(result.updated_content, "alpha\nBETA\ngamma\n");
        assert_eq!(result.operation, HashlineOperation::Replace);
        assert_eq!((result.changed_start_line, result.changed_end_line), (2, 2));
    }

    #[test]
    fn rejects_hash_mismatch() {
        let err = apply_hashline_edit(
            "alpha\nbeta\ngamma\n",
            &HashlineEditArgs {
                line_ref: Some("L2#00000000".into()),
                operation: Some("replace".into()),
                content: Some("BETA".into()),
                ..HashlineEditArgs::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("hash mismatch"));
        assert!(err.contains("Current ref:"));
    }

    #[test]
    fn hashline_validation_error_strings_are_exact() {
        let err = apply_hashline_edit("x\n", &HashlineEditArgs::default()).unwrap_err();
        assert_eq!(err, "lineRef is required for hashline edit mode.");

        let err = apply_hashline_edit(
            "x\n",
            &HashlineEditArgs {
                line_ref: Some("nope".into()),
                ..HashlineEditArgs::default()
            },
        )
        .unwrap_err();
        assert_eq!(err, "Invalid lineRef format: nope. Expected L<line>#<hash>.");

        let err = apply_hashline_edit(
            "a\nb\n",
            &HashlineEditArgs {
                line_ref: Some(format_hashline_ref(2, "b")),
                end_line_ref: Some(format_hashline_ref(1, "a")),
                ..HashlineEditArgs::default()
            },
        )
        .unwrap_err();
        assert_eq!(err, "endLineRef must be on or after lineRef.");

        let err = apply_hashline_edit(
            "a\n",
            &HashlineEditArgs {
                line_ref: Some(format_hashline_ref(1, "a")),
                operation: Some("smash".into()),
                ..HashlineEditArgs::default()
            },
        )
        .unwrap_err();
        assert_eq!(
            err,
            "Invalid operation. Use one of: replace, insert_before, insert_after, delete."
        );

        let err = apply_hashline_edit(
            "a\n",
            &HashlineEditArgs {
                line_ref: Some("L5#abcdef01".into()),
                ..HashlineEditArgs::default()
            },
        )
        .unwrap_err();
        assert_eq!(err, "lineRef is out of range (L5#abcdef01). File has 1 line(s).");

        let err = apply_hashline_edit(
            "a\n",
            &HashlineEditArgs {
                line_ref: Some(format_hashline_ref(1, "a")),
                operation: Some("insert_before".into()),
                ..HashlineEditArgs::default()
            },
        )
        .unwrap_err();
        assert_eq!(err, "content is required for insert_before.");
    }

    #[test]
    fn insert_delete_and_range_semantics() {
        let content = "a\nb\nc\n";
        // insert_after
        let result = apply_hashline_edit(
            content,
            &HashlineEditArgs {
                line_ref: Some(format_hashline_ref(1, "a")),
                operation: Some("insert_after".into()),
                content: Some("x\ny".into()),
                ..HashlineEditArgs::default()
            },
        )
        .expect("ok");
        assert_eq!(result.updated_content, "a\nx\ny\nb\nc\n");
        assert_eq!((result.changed_start_line, result.changed_end_line), (2, 3));

        // insert_before
        let result = apply_hashline_edit(
            content,
            &HashlineEditArgs {
                line_ref: Some(format_hashline_ref(2, "b")),
                operation: Some("insert_before".into()),
                content: Some("x".into()),
                ..HashlineEditArgs::default()
            },
        )
        .expect("ok");
        assert_eq!(result.updated_content, "a\nx\nb\nc\n");
        assert_eq!((result.changed_start_line, result.changed_end_line), (2, 2));

        // delete range
        let result = apply_hashline_edit(
            content,
            &HashlineEditArgs {
                line_ref: Some(format_hashline_ref(1, "a")),
                end_line_ref: Some(format_hashline_ref(2, "b")),
                operation: Some("delete".into()),
                ..HashlineEditArgs::default()
            },
        )
        .expect("ok");
        assert_eq!(result.updated_content, "c\n");
        assert_eq!((result.changed_start_line, result.changed_end_line), (1, 1));

        // delete everything → no trailing newline flag left.
        let result = apply_hashline_edit(
            "only\n",
            &HashlineEditArgs {
                line_ref: Some(format_hashline_ref(1, "only")),
                operation: Some("delete".into()),
                ..HashlineEditArgs::default()
            },
        )
        .expect("ok");
        assert_eq!(result.updated_content, "");
    }

    #[test]
    fn preserves_crlf_and_trailing_newline_state() {
        let content = "a\r\nb\r\nc";
        let result = apply_hashline_edit(
            content,
            &HashlineEditArgs {
                line_ref: Some(format_hashline_ref(2, "b")),
                operation: Some("replace".into()),
                content: Some("B".into()),
                ..HashlineEditArgs::default()
            },
        )
        .expect("ok");
        assert_eq!(result.updated_content, "a\r\nB\r\nc");

        // newString works as the replacement body too.
        let result = apply_hashline_edit(
            "a\nb\n",
            &HashlineEditArgs {
                line_ref: Some(format_hashline_ref(1, "a")),
                new_string: Some("A".into()),
                operation: Some("replace".into()),
                ..HashlineEditArgs::default()
            },
        )
        .expect("ok");
        assert_eq!(result.updated_content, "A\nb\n");
    }

    #[test]
    fn build_updated_refs_clamps_range() {
        let refs = build_updated_refs("a\nb\nc\n", 2, 9);
        assert_eq!(refs.len(), 2);
        assert!(refs[0].starts_with(&format_hashline_ref(2, "b")));
        assert!(refs[1].starts_with(&format_hashline_ref(3, "c")));
        assert!(build_updated_refs("", 1, 1).is_empty());
    }
}
