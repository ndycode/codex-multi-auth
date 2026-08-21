//! Port of `lib/runtime/config-toml.ts` — byte-exact line/string manipulation
//! over Codex's `config.toml`.
//!
//! NOT a real TOML parser: line-based rewriting with the file's dominant EOL
//! preserved (any `\r\n` in the input ⇒ output joined with `\r\n`, else `\n`).
//! `boundConfigHash` in the app-bind state is the sha256 of the exact rewrite
//! output, so every helper here must reproduce the TS byte-for-byte: the single
//! blank line before the provider block, `experimental_bearer_token` inserted
//! at index 4, uppercase `\uXXXX` escapes, and the LF-only final newline of
//! `ensure_toml_trailing_newline` even in CRLF files (except the
//! `..._without_backup` path, which force-normalizes ALL EOLs to the input
//! style). See spec 10 §2 + gotcha 1.

use cma_core::constants::RUNTIME_ROTATION_PROXY_PROVIDER_ID;

/// Double-quoted TOML basic string; escapes control chars (U+0000–U+001F,
/// U+007F), `\` and `"`. Named escapes for `\b \t \n \f \r " \\`; everything
/// else in the class becomes `\uXXXX` with UPPERCASE 4-hex digits.
pub fn toml_string_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '\u{0008}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{000c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) <= 0x001f || c as u32 == 0x007f => {
                out.push_str(&format!("\\u{:04X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `readTomlTableName` — emulates `^\s*\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*$`.
/// Returns the trimmed table name for `[t]` / `[[t]]` headers, else `None`.
fn read_toml_table_name(line: &str) -> Option<&str> {
    let trimmed = line.trim_matches(is_js_whitespace);
    if !trimmed.starts_with('[') || !trimmed.ends_with(']') {
        return None;
    }
    let open = if trimmed.starts_with("[[") { 2 } else { 1 };
    let close = if trimmed.ends_with("]]") { 2 } else { 1 };
    if trimmed.len() < open + close {
        return None;
    }
    let inner = &trimmed[open..trimmed.len() - close];
    let name = inner.trim_matches(is_js_whitespace);
    // `[^\]]+?` — the name may not contain `]` and must be non-empty.
    if name.is_empty() || name.contains(']') {
        return None;
    }
    Some(name)
}

/// JS `\s` approximation (Unicode whitespace + BOM; `char::is_whitespace`
/// covers the JS class for every character plausible in a config file).
fn is_js_whitespace(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// `rawConfig.split(/\r?\n/)` — split on `\n`, stripping ONE optional
/// preceding `\r` from each piece.
fn split_lines(raw: &str) -> Vec<&str> {
    raw.split('\n')
        .map(|piece| piece.strip_suffix('\r').unwrap_or(piece))
        .collect()
}

/// `rawConfig.length > 0 ? split : []` guard used by several helpers.
fn split_lines_guarded(raw: &str) -> Vec<&str> {
    if raw.is_empty() {
        Vec::new()
    } else {
        split_lines(raw)
    }
}

fn dominant_eol(raw: &str) -> &'static str {
    if raw.contains("\r\n") { "\r\n" } else { "\n" }
}

/// `/^\s*<key>\s*=/` test.
fn is_key_assignment(line: &str, key: &str) -> bool {
    let rest = line.trim_start_matches(is_js_whitespace);
    let Some(rest) = rest.strip_prefix(key) else {
        return false;
    };
    rest.trim_start_matches(is_js_whitespace).starts_with('=')
}

/// `/^\s*disable_response_storage\s*=\s*true\s*(?:#.*)?$/i` test.
fn is_disable_response_storage_true(line: &str) -> bool {
    let lower = line.to_lowercase();
    let rest = lower.trim_start_matches(is_js_whitespace);
    let Some(rest) = rest.strip_prefix("disable_response_storage") else {
        return false;
    };
    let rest = rest.trim_start_matches(is_js_whitespace);
    let Some(rest) = rest.strip_prefix('=') else {
        return false;
    };
    let rest = rest.trim_start_matches(is_js_whitespace);
    let Some(rest) = rest.strip_prefix("true") else {
        return false;
    };
    let rest = rest.trim_start_matches(is_js_whitespace);
    rest.is_empty() || rest.starts_with('#')
}

/// Strip ALL trailing `\r`/`\n` characters (`.replace(/[\r\n]*$/, "")`).
fn strip_trailing_newlines(value: &str) -> &str {
    value.trim_end_matches(['\r', '\n'])
}

/// `ensureTomlTrailingNewline` — `value.replace(/[\r\n]*$/, "\n")`. The final
/// newline is always LF even in CRLF files (deliberate/observed TS behavior).
fn ensure_toml_trailing_newline(value: &str) -> String {
    format!("{}\n", strip_trailing_newlines(value))
}

fn provider_table_name() -> String {
    format!("model_providers.{RUNTIME_ROTATION_PROXY_PROVIDER_ID}")
}

fn remove_runtime_rotation_provider_block(raw_config: &str) -> String {
    let lines = split_lines(raw_config);
    let provider_table = provider_table_name();
    let child_prefix = format!("{provider_table}.");
    let mut output: Vec<&str> = Vec::with_capacity(lines.len());
    let mut skipping = false;
    for line in lines {
        let table_name = read_toml_table_name(line);
        if table_name == Some(provider_table.as_str()) {
            skipping = true;
            continue;
        }
        if skipping && let Some(name) = table_name {
            if name == provider_table || name.starts_with(child_prefix.as_str()) {
                continue;
            }
            skipping = false;
        }
        if !skipping {
            output.push(line);
        }
    }
    output.join(dominant_eol(raw_config))
}

fn rewrite_top_level_model_provider(raw_config: &str) -> String {
    let line_ending = dominant_eol(raw_config);
    let lines = split_lines_guarded(raw_config);
    let rewritten_line = format!(
        "model_provider = {}",
        toml_string_literal(RUNTIME_ROTATION_PROXY_PROVIDER_ID)
    );
    let mut replaced = false;
    let mut output: Vec<String> = Vec::with_capacity(lines.len() + 1);

    for line in lines {
        let is_table = read_toml_table_name(line).is_some();
        if !replaced && is_table {
            output.push(rewritten_line.clone());
            replaced = true;
        }
        if !replaced && is_key_assignment(line, "model_provider") {
            output.push(rewritten_line.clone());
            replaced = true;
            continue;
        }
        output.push(line.to_string());
    }

    if !replaced {
        output.push(rewritten_line);
    }
    output.join(line_ending)
}

fn enable_top_level_response_storage(raw_config: &str) -> String {
    let line_ending = dominant_eol(raw_config);
    let lines = split_lines_guarded(raw_config);
    let mut output: Vec<String> = Vec::with_capacity(lines.len());
    let mut in_top_level = true;

    for line in lines {
        if read_toml_table_name(line).is_some() {
            in_top_level = false;
            output.push(line.to_string());
            continue;
        }
        if in_top_level && is_disable_response_storage_true(line) {
            output.push("disable_response_storage = false".to_string());
            continue;
        }
        output.push(line.to_string());
    }

    output.join(line_ending)
}

/// Verbatim first `^\s*<key>\s*=` line (incl. indentation/comment) before any
/// table header.
fn extract_top_level_line<'a>(raw_config: &'a str, key: &str) -> Option<&'a str> {
    for line in split_lines(raw_config) {
        if read_toml_table_name(line).is_some() {
            return None;
        }
        if is_key_assignment(line, key) {
            return Some(line);
        }
    }
    None
}

/// Replaces the first `model_provider = …` line containing the proxy id with
/// the original config's top-level `model_provider` line (or drops it when the
/// original had none). Un-replaced original lines are spliced back before the
/// first section header only when the current config has no top-level
/// `model_provider` at all (avoids duplicate keys on half-orphaned configs).
pub fn restore_top_level_model_provider(current_config: &str, original_config: &str) -> String {
    let line_ending = dominant_eol(current_config);
    let original_line = extract_top_level_line(original_config, "model_provider");
    let lines = split_lines_guarded(current_config);
    let mut output: Vec<String> = Vec::with_capacity(lines.len() + 1);
    let mut handled = false;

    for line in lines {
        let is_runtime_provider_line = is_key_assignment(line, "model_provider")
            && line.contains(RUNTIME_ROTATION_PROXY_PROVIDER_ID);
        if is_runtime_provider_line && !handled {
            if let Some(original) = original_line {
                output.push(original.to_string());
            }
            handled = true;
            continue;
        }
        output.push(line.to_string());
    }

    if !handled && let Some(original) = original_line {
        let has_top_level_model_provider = {
            let mut found = false;
            for line in &output {
                if read_toml_table_name(line).is_some() {
                    break;
                }
                if is_key_assignment(line, "model_provider") {
                    found = true;
                    break;
                }
            }
            found
        };
        if !has_top_level_model_provider {
            // Splice the restored line into the root table — appending at tail
            // would land it inside whatever section appears last.
            let first_section_idx = output
                .iter()
                .position(|line| read_toml_table_name(line).is_some());
            match first_section_idx {
                None => output.push(original.to_string()),
                Some(idx) => output.insert(idx, original.to_string()),
            }
        }
    }

    output.join(line_ending)
}

/// Same pattern for `disable_response_storage`: replaces the first top-level
/// occurrence with the original line (or drops the bind-written residue when
/// the original had none); un-replaced original lines are spliced before the
/// first section header.
pub fn restore_top_level_response_storage(current_config: &str, original_config: &str) -> String {
    let line_ending = dominant_eol(current_config);
    let original_line = extract_top_level_line(original_config, "disable_response_storage");
    let lines = split_lines_guarded(current_config);
    let mut output: Vec<String> = Vec::with_capacity(lines.len() + 1);
    let mut handled = false;
    let mut in_top_level = true;

    for line in lines {
        if read_toml_table_name(line).is_some() {
            in_top_level = false;
            output.push(line.to_string());
            continue;
        }
        if !handled && in_top_level && is_key_assignment(line, "disable_response_storage") {
            if let Some(original) = original_line {
                output.push(original.to_string());
            }
            // If no original line, drop the line we wrote during bind.
            handled = true;
            continue;
        }
        output.push(line.to_string());
    }

    if !handled && let Some(original) = original_line {
        // Mirror restore_top_level_model_provider: splice before the first
        // section header instead of appending at tail.
        let first_section_idx = output
            .iter()
            .position(|line| read_toml_table_name(line).is_some());
        match first_section_idx {
            None => output.push(original.to_string()),
            Some(idx) => output.insert(idx, original.to_string()),
        }
    }

    output.join(line_ending)
}

fn create_runtime_rotation_provider_block(base_url: &str, client_api_key: &str) -> Vec<String> {
    let mut lines = vec![
        format!("[model_providers.{RUNTIME_ROTATION_PROXY_PROVIDER_ID}]"),
        "name = \"codex-multi-auth\"".to_string(),
        format!("base_url = {}", toml_string_literal(base_url)),
        "requires_openai_auth = false".to_string(),
        "wire_api = \"responses\"".to_string(),
    ];
    if !client_api_key.trim().is_empty() {
        lines.insert(
            4,
            format!(
                "experimental_bearer_token = {}",
                toml_string_literal(client_api_key)
            ),
        );
    }
    lines
}

/// Bind rewrite: strip any existing proxy provider block, rewrite/insert the
/// top-level `model_provider`, flip a top-level `disable_response_storage =
/// true` to `false`, then append the provider block after one blank line.
/// Output always ends with exactly one EOL (the input's dominant style).
pub fn rewrite_config_toml_for_runtime_rotation_provider(
    raw_config: &str,
    base_url: &str,
    client_api_key: &str,
) -> String {
    let line_ending = dominant_eol(raw_config);
    let without_old_provider = remove_runtime_rotation_provider_block(raw_config);
    let without_old_provider = strip_trailing_newlines(&without_old_provider);
    let with_model_provider = rewrite_top_level_model_provider(without_old_provider);
    let with_model_provider = strip_trailing_newlines(&with_model_provider);
    let with_response_storage = enable_top_level_response_storage(with_model_provider);
    let with_response_storage = strip_trailing_newlines(&with_response_storage);
    let provider_block =
        create_runtime_rotation_provider_block(base_url, client_api_key).join(line_ending);
    format!("{with_response_storage}{line_ending}{line_ending}{provider_block}{line_ending}")
}

/// Unbind restore: strip the provider block, restore the original top-level
/// `disable_response_storage` line, restore the original top-level
/// `model_provider` line; trailing whitespace normalized to a single `\n`
/// (LF even in CRLF files — deliberate TS behavior).
pub fn restore_config_toml_from_runtime_rotation_provider(
    current_config: &str,
    original_config: &str,
) -> String {
    let without_provider = remove_runtime_rotation_provider_block(current_config);
    let with_response_storage =
        restore_top_level_response_storage(&without_provider, original_config);
    let restored = restore_top_level_model_provider(&with_response_storage, original_config);
    ensure_toml_trailing_newline(strip_trailing_newlines(&restored))
}

/// True when the proxy table header exists anywhere, or a **top-level**
/// `model_provider = …` line contains the proxy id. Empty string → false.
/// Only lines before the first table header count as top-level. Used to
/// recover an orphaned bind (#614) whose state/backup files were lost.
pub fn config_has_runtime_rotation_provider(raw_config: &str) -> bool {
    if raw_config.is_empty() {
        return false;
    }
    let provider_table = provider_table_name();
    let mut in_top_level = true;
    for line in split_lines(raw_config) {
        if let Some(table_name) = read_toml_table_name(line) {
            if table_name == provider_table {
                return true;
            }
            in_top_level = false;
            continue;
        }
        if in_top_level
            && is_key_assignment(line, "model_provider")
            && line.contains(RUNTIME_ROTATION_PROXY_PROVIDER_ID)
        {
            return true;
        }
    }
    false
}

/// Orphaned-bind recovery restore (no backup available): synthesizes a minimal
/// original config of `model_provider = "<default_provider>"` and runs the
/// shared restore, then force-normalizes ALL line endings of the result to the
/// input config's style (CRLF stays CRLF, LF stays LF) — this is the one
/// restore path with full-EOL normalization.
pub fn restore_config_toml_from_runtime_rotation_provider_without_backup(
    current_config: &str,
    default_provider: Option<&str>,
) -> String {
    let default_provider = default_provider.unwrap_or("openai");
    let line_ending = dominant_eol(current_config);
    let synthetic_original = format!(
        "model_provider = {}{line_ending}",
        toml_string_literal(default_provider)
    );
    let restored =
        restore_config_toml_from_runtime_rotation_provider(current_config, &synthetic_original);
    if line_ending == "\r\n" {
        // `.replace(/\r?\n/g, "\r\n")` — every `\n` (with one optional
        // preceding `\r`) becomes `\r\n`.
        let mut out = String::with_capacity(restored.len() + 16);
        let mut rest = restored.as_str();
        while let Some(idx) = rest.find('\n') {
            let (mut text, tail) = rest.split_at(idx);
            if let Some(stripped) = text.strip_suffix('\r') {
                text = stripped;
            }
            out.push_str(text);
            out.push_str("\r\n");
            rest = &tail[1..];
        }
        out.push_str(rest);
        out
    } else {
        restored.replace("\r\n", "\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROXY_ID: &str = RUNTIME_ROTATION_PROXY_PROVIDER_ID;

    // ----- tomlStringLiteral (app-bind.test.ts "escapes TOML basic-string control characters") -----

    #[test]
    fn escapes_toml_basic_string_control_characters() {
        let input = "line\ncarriage\rtab\tbackspace\u{0008}form\u{000c}quote\"slash\\nul\u{0000}unit\u{001f}del\u{007f}";
        assert_eq!(
            toml_string_literal(input),
            "\"line\\ncarriage\\rtab\\tbackspace\\bform\\fquote\\\"slash\\\\nul\\u0000unit\\u001Fdel\\u007F\""
        );
    }

    // ----- rewrite + restore round trip (app-bind.test.ts) -----

    #[test]
    fn rewrites_and_restores_codex_config_toml_without_disturbing_other_sections() {
        let original = [
            "model_provider = \"openai\"",
            "model = \"gpt-5.4\"",
            "disable_response_storage = true",
            "",
            "[profiles.default]",
            "model = \"gpt-5.4\"",
            "disable_response_storage = true",
            "",
        ]
        .join("\n");

        let bound = rewrite_config_toml_for_runtime_rotation_provider(
            &original,
            "http://127.0.0.1:32123",
            "app-secret",
        );
        assert!(bound.contains(&format!("model_provider = \"{PROXY_ID}\"")));
        assert!(bound.contains(&format!("[model_providers.{PROXY_ID}]")));
        assert!(bound.contains("name = \"codex-multi-auth\""));
        assert!(bound.contains("base_url = \"http://127.0.0.1:32123\""));
        assert!(bound.contains("requires_openai_auth = false"));
        assert!(bound.contains("experimental_bearer_token = \"app-secret\""));
        assert!(bound.contains("wire_api = \"responses\""));
        assert!(bound.contains("disable_response_storage = false"));
        assert!(
            bound.contains(
                "[profiles.default]\nmodel = \"gpt-5.4\"\ndisable_response_storage = true"
            )
        );
        assert!(!bound.contains("env_key"));

        let restored = restore_config_toml_from_runtime_rotation_provider(&bound, &original);
        assert_eq!(restored, original);
    }

    #[test]
    fn bearer_token_omitted_when_client_api_key_blank() {
        let bound =
            rewrite_config_toml_for_runtime_rotation_provider("", "http://127.0.0.1:1", "  ");
        assert!(!bound.contains("experimental_bearer_token"));
        let idx_requires = bound.find("requires_openai_auth = false").unwrap();
        let idx_wire = bound.find("wire_api = \"responses\"").unwrap();
        assert!(idx_requires < idx_wire);
    }

    #[test]
    fn keeps_model_provider_top_level_before_toml_array_tables() {
        let original = ["[[profiles.experimental]]", "model = \"gpt-5.4\"", ""].join("\n");
        let bound = rewrite_config_toml_for_runtime_rotation_provider(
            &original,
            "http://127.0.0.1:32123",
            "app-secret",
        );
        let provider_line = format!("model_provider = \"{PROXY_ID}\"");
        assert!(bound.starts_with(&provider_line));
        assert!(
            bound.find(&provider_line).unwrap() < bound.find("[[profiles.experimental]]").unwrap()
        );
    }

    #[test]
    fn removes_runtime_provider_subtables_when_restoring() {
        let bound = [
            format!("model_provider = \"{PROXY_ID}\""),
            String::new(),
            format!("[model_providers.{PROXY_ID}]"),
            "name = \"codex-multi-auth\"".to_string(),
            "base_url = \"http://127.0.0.1:32123\"".to_string(),
            format!("[model_providers.{PROXY_ID}.http_headers]"),
            "authorization = \"Bearer secret\"".to_string(),
            "[profiles.default]".to_string(),
            "model = \"gpt-5.4\"".to_string(),
            String::new(),
        ]
        .join("\n");

        let restored = restore_config_toml_from_runtime_rotation_provider(
            &bound,
            "model_provider = \"openai\"\n",
        );
        assert!(!restored.contains(PROXY_ID));
        assert!(!restored.contains("Bearer secret"));
        assert!(restored.contains("[profiles.default]"));
    }

    // ----- restoreTopLevelModelProvider (config-toml-restore.test.ts) -----

    #[test]
    fn rewrites_the_runtime_rotation_provider_line_back_to_the_original() {
        let original = "model_provider = \"openai\"\n[profiles.default]\nmodel = \"gpt-5\"\n";
        let current =
            format!("model_provider = \"{PROXY_ID}\"\n[profiles.default]\nmodel = \"gpt-5\"\n");
        assert_eq!(restore_top_level_model_provider(&current, original), original);
    }

    #[test]
    fn splices_the_original_model_provider_before_the_first_section_when_current_omits_it() {
        let original = "model_provider = \"openai\"\n[profiles.default]\nmodel = \"gpt-5\"\n";
        let current = "[profiles.default]\nmodel = \"gpt-5\"\n";
        let restored = restore_top_level_model_provider(current, original);
        let lines: Vec<&str> = restored.split('\n').collect();
        let provider_idx = lines
            .iter()
            .position(|l| is_key_assignment(l, "model_provider"))
            .expect("provider line present");
        let section_idx = lines
            .iter()
            .position(|l| l.trim_start().starts_with('['))
            .expect("section header present");
        assert!(provider_idx < section_idx);
    }

    #[test]
    fn appends_the_original_model_provider_at_tail_when_no_section_header_exists() {
        let original = "model_provider = \"openai\"\n";
        let current = "# nothing here\n";
        let restored = restore_top_level_model_provider(current, original);
        assert!(restored.contains("model_provider = \"openai\""));
    }

    #[test]
    fn preserves_crlf_line_endings_end_to_end() {
        let original =
            "model_provider = \"openai\"\r\n[profiles.default]\r\nmodel = \"gpt-5\"\r\n";
        let current = format!(
            "model_provider = \"{PROXY_ID}\"\r\n[profiles.default]\r\nmodel = \"gpt-5\"\r\n"
        );
        let restored = restore_top_level_model_provider(&current, original);
        assert_eq!(restored, original);
        assert!(!restored.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn leaves_config_untouched_when_neither_side_has_the_runtime_line() {
        let original = "[profiles.default]\nmodel = \"gpt-5\"\n";
        let current = "[profiles.default]\nmodel = \"gpt-5\"\n";
        assert_eq!(restore_top_level_model_provider(current, original), current);
    }

    // ----- restoreTopLevelResponseStorage -----

    #[test]
    fn restores_the_original_disable_response_storage_line_when_present() {
        let original = "disable_response_storage = true\n[profiles.default]\n";
        let current = "disable_response_storage = false\n[profiles.default]\n";
        assert_eq!(restore_top_level_response_storage(current, original), original);
    }

    #[test]
    fn drops_bind_time_disable_response_storage_residue_when_original_lacks_it() {
        let original = "[profiles.default]\nmodel = \"gpt-5\"\n";
        let current = "disable_response_storage = false\n[profiles.default]\nmodel = \"gpt-5\"\n";
        let restored = restore_top_level_response_storage(current, original);
        assert!(!restored.contains("disable_response_storage"));
        assert!(restored.contains("[profiles.default]"));
    }

    #[test]
    fn splices_the_original_response_storage_line_before_the_first_section_when_current_omits_it()
    {
        let original = "disable_response_storage = true\n[profiles.default]\n";
        let current = "[profiles.default]\nmodel = \"gpt-5\"\n";
        let restored = restore_top_level_response_storage(current, original);
        let lines: Vec<&str> = restored.split('\n').collect();
        let setting_idx = lines
            .iter()
            .position(|l| is_key_assignment(l, "disable_response_storage"))
            .expect("setting line present");
        let section_idx = lines
            .iter()
            .position(|l| l.trim_start().starts_with('['))
            .expect("section header present");
        assert!(setting_idx < section_idx);
        assert!(restored.contains("disable_response_storage = true"));
    }

    #[test]
    fn appends_the_original_response_storage_line_at_tail_when_no_section_header() {
        let original = "disable_response_storage = true\n";
        let current = "# nothing here\n";
        let restored = restore_top_level_response_storage(current, original);
        assert!(restored.contains("disable_response_storage = true"));
    }

    #[test]
    fn does_not_strip_a_disable_response_storage_written_inside_a_section() {
        let original = "[profiles.default]\nmodel = \"gpt-5\"\n";
        let current = "[profiles.default]\ndisable_response_storage = false\nmodel = \"gpt-5\"\n";
        let restored = restore_top_level_response_storage(current, original);
        assert!(restored.contains("disable_response_storage = false"));
    }

    // ----- configHasRuntimeRotationProvider -----

    #[test]
    fn detects_a_top_level_model_provider_bound_to_the_proxy() {
        let config =
            format!("model_provider = \"{PROXY_ID}\"\n[profiles.default]\nmodel = \"gpt-5\"\n");
        assert!(config_has_runtime_rotation_provider(&config));
    }

    #[test]
    fn detects_the_proxy_provider_block_even_when_model_provider_is_native() {
        let config = format!(
            "model_provider = \"openai\"\n[model_providers.{PROXY_ID}]\nname = \"codex-multi-auth\"\n"
        );
        assert!(config_has_runtime_rotation_provider(&config));
    }

    #[test]
    fn returns_false_for_an_unbound_config() {
        let config = "model_provider = \"openai\"\n[profiles.default]\nmodel = \"gpt-5\"\n";
        assert!(!config_has_runtime_rotation_provider(config));
    }

    #[test]
    fn returns_false_for_empty_config() {
        assert!(!config_has_runtime_rotation_provider(""));
    }

    #[test]
    fn does_not_match_a_proxy_id_that_only_appears_inside_a_non_provider_section() {
        let config = format!("[profiles.default]\nnote = \"{PROXY_ID}\"\n");
        assert!(!config_has_runtime_rotation_provider(&config));
    }

    // ----- restoreConfigTomlFromRuntimeRotationProviderWithoutBackup -----

    #[test]
    fn rewrites_a_bound_model_provider_to_the_default_and_strips_the_proxy_block() {
        let bound = [
            format!("model_provider = \"{PROXY_ID}\""),
            "[profiles.default]".to_string(),
            "model = \"gpt-5\"".to_string(),
            String::new(),
            format!("[model_providers.{PROXY_ID}]"),
            "name = \"codex-multi-auth\"".to_string(),
            "base_url = \"http://127.0.0.1:51758\"".to_string(),
            "requires_openai_auth = false".to_string(),
            "wire_api = \"responses\"".to_string(),
            String::new(),
        ]
        .join("\n");

        let restored =
            restore_config_toml_from_runtime_rotation_provider_without_backup(&bound, None);
        assert!(restored.contains("model_provider = \"openai\""));
        assert!(!restored.contains(PROXY_ID));
        assert!(restored.contains("[profiles.default]"));
        assert!(!config_has_runtime_rotation_provider(&restored));
    }

    #[test]
    fn honors_a_custom_default_provider() {
        let bound = format!("model_provider = \"{PROXY_ID}\"\n");
        let restored = restore_config_toml_from_runtime_rotation_provider_without_backup(
            &bound,
            Some("my-provider"),
        );
        assert!(restored.contains("model_provider = \"my-provider\""));
    }

    #[test]
    fn preserves_crlf_endings_when_recovering() {
        let bound = format!(
            "model_provider = \"{PROXY_ID}\"\r\n[model_providers.{PROXY_ID}]\r\nname = \"codex-multi-auth\"\r\n"
        );
        let restored =
            restore_config_toml_from_runtime_rotation_provider_without_backup(&bound, None);
        assert!(restored.contains("model_provider = \"openai\""));
        assert!(!restored.contains(PROXY_ID));
        assert!(!restored.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn does_not_duplicate_model_provider_on_half_orphan() {
        let half_orphan = [
            "model_provider = \"openai\"".to_string(),
            "[profiles.default]".to_string(),
            "model = \"gpt-5\"".to_string(),
            String::new(),
            format!("[model_providers.{PROXY_ID}]"),
            "name = \"codex-multi-auth\"".to_string(),
            "base_url = \"http://127.0.0.1:51758\"".to_string(),
            "wire_api = \"responses\"".to_string(),
            String::new(),
        ]
        .join("\n");

        let restored =
            restore_config_toml_from_runtime_rotation_provider_without_backup(&half_orphan, None);
        let provider_lines = restored
            .split('\n')
            .filter(|line| is_key_assignment(line, "model_provider"))
            .count();
        assert_eq!(provider_lines, 1);
        assert!(restored.contains("model_provider = \"openai\""));
        assert!(!restored.contains(PROXY_ID));
        assert!(restored.contains("[profiles.default]"));
    }

    #[test]
    fn drops_bind_injected_disable_response_storage_during_no_backup_recovery() {
        let bound = [
            format!("model_provider = \"{PROXY_ID}\""),
            "disable_response_storage = false".to_string(),
            "[profiles.default]".to_string(),
            "model = \"gpt-5\"".to_string(),
            String::new(),
            format!("[model_providers.{PROXY_ID}]"),
            "wire_api = \"responses\"".to_string(),
            String::new(),
        ]
        .join("\n");

        let restored =
            restore_config_toml_from_runtime_rotation_provider_without_backup(&bound, None);
        assert!(restored.contains("model_provider = \"openai\""));
        assert!(!restored.contains("disable_response_storage"));
        assert!(!restored.contains(PROXY_ID));
    }

    // ----- byte-exactness details -----

    #[test]
    fn bind_output_ends_with_exactly_one_eol_and_one_blank_line_before_block() {
        let original = "model_provider = \"openai\"\n";
        let bound =
            rewrite_config_toml_for_runtime_rotation_provider(original, "http://127.0.0.1:9", "");
        let expected = format!(
            "model_provider = \"{PROXY_ID}\"\n\n[model_providers.{PROXY_ID}]\nname = \"codex-multi-auth\"\nbase_url = \"http://127.0.0.1:9\"\nrequires_openai_auth = false\nwire_api = \"responses\"\n"
        );
        assert_eq!(bound, expected);
    }

    #[test]
    fn restore_final_newline_is_lf_even_in_crlf_files() {
        let original = "model_provider = \"openai\"\r\nmodel = \"gpt-5\"\r\n";
        let bound = rewrite_config_toml_for_runtime_rotation_provider(
            original,
            "http://127.0.0.1:9",
            "key",
        );
        assert!(bound.contains("\r\n"));
        let restored = restore_config_toml_from_runtime_rotation_provider(&bound, original);
        assert!(restored.ends_with('\n'));
        assert!(!restored.ends_with("\r\n"));
    }

    #[test]
    fn table_name_parser_matches_regex_semantics() {
        assert_eq!(read_toml_table_name("[a]"), Some("a"));
        assert_eq!(
            read_toml_table_name("  [[ profiles.default ]]  "),
            Some("profiles.default")
        );
        assert_eq!(read_toml_table_name("[[a]"), Some("a"));
        assert_eq!(read_toml_table_name("[a]]"), Some("a"));
        assert_eq!(read_toml_table_name("[]"), None);
        assert_eq!(read_toml_table_name("[a] # comment"), None);
        assert_eq!(read_toml_table_name("[a]b]"), None);
        assert_eq!(read_toml_table_name("key = \"[a]\""), None);
        assert_eq!(read_toml_table_name("[[[a]]]"), None);
    }
}
