//! Golden-fixture helpers — byte-compare test output against TS-produced fixtures
//! under `crates/testkit/goldens/` (ARCHITECTURE.md §7 F6 / §9.1).
//!
//! Golden fixtures are the byte-compat gate for every persisted format (accounts
//! v3, WAL, flagged, settings.json, quota-cache, …). They are **seeded by running
//! the existing TypeScript tool** — the Rust side only READS them. There is
//! deliberately no "bless"/update mode here: regenerating goldens from Rust output
//! would let byte drift certify itself (§8.1 is the contract these tests enforce).
//!
//! Primary API: [`assert_golden_bytes`] — compare exact bytes with a diagnostic
//! diff (first-diff offset, line diff, trailing-newline and JSON-formatting-only
//! notes). [`assert_golden_json`] is a softer, *semantic* JSON comparison for
//! tests that only care about structure; it is NOT a substitute for the byte gate.
//!
//! Fixture names use `/` separators relative to the goldens root (e.g.
//! `"accounts/v3-minimal.json"`). The root resolves to
//! `<this crate>/goldens/`, overridable via the [`GOLDENS_DIR_ENV`] env var
//! (tests that set it must be `#[serial(env)]` and should do so through
//! [`crate::sandbox::EnvSandbox::set_var`]).
//!
//! For snapshot-style tests (as opposed to TS-seeded byte fixtures), use the
//! `insta` crate directly from your own test module — its macros must expand at
//! the call site so snapshots land next to the calling crate, which is why this
//! module does not wrap them.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Env var that overrides the goldens root directory. Intended for harness
/// tests; production test suites should rely on the default in-repo location.
pub const GOLDENS_DIR_ENV: &str = "CMA_TESTKIT_GOLDENS_DIR";

/// The goldens root: `$CMA_TESTKIT_GOLDENS_DIR` when set and non-empty,
/// otherwise `crates/testkit/goldens/` (resolved from this crate's manifest dir,
/// so it is stable regardless of the working directory `cargo test` uses).
pub fn goldens_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os(GOLDENS_DIR_ENV)
        && !dir.is_empty()
    {
        return PathBuf::from(dir);
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("goldens")
}

/// Absolute path of a named golden fixture.
///
/// # Panics
/// Panics on malformed names (empty, `\` separators, `.`/`..` components,
/// absolute paths, or components containing `:`); goldens are addressed only by
/// forward-slash-relative names inside the goldens root.
pub fn golden_path(name: &str) -> PathBuf {
    join_validated(&goldens_dir(), name)
}

/// Read a golden fixture, returning the raw `io::Result` for callers that treat
/// a missing fixture as an expected condition.
pub fn try_read_golden_bytes(name: &str) -> io::Result<Vec<u8>> {
    fs::read(golden_path(name))
}

/// Read a golden fixture's bytes, panicking with an actionable message (goldens
/// root, available fixture list, seeding instructions) when it cannot be read.
pub fn read_golden_bytes(name: &str) -> Vec<u8> {
    read_bytes_at(&goldens_dir(), name)
}

/// Read a golden fixture as UTF-8 text.
///
/// # Panics
/// Panics when the fixture is missing (see [`read_golden_bytes`]) or not UTF-8.
pub fn read_golden_string(name: &str) -> String {
    let bytes = read_golden_bytes(name);
    match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => panic!("golden fixture {name:?} is not valid UTF-8: {error}"),
    }
}

/// Read and parse a golden fixture as JSON.
///
/// # Panics
/// Panics when the fixture is missing or not valid JSON.
pub fn read_golden_json(name: &str) -> Value {
    read_json_at(&goldens_dir(), name)
}

/// List every available golden fixture name (recursive, `/`-separated, sorted).
/// Returns an empty list when the goldens directory does not exist yet.
pub fn available_goldens() -> Vec<String> {
    let dir = goldens_dir();
    let mut names = Vec::new();
    collect_names(&dir, &dir, &mut names);
    names.sort();
    names
}

/// THE byte-compat assertion: `actual` must equal the golden fixture
/// byte-for-byte. On mismatch, panics with the first-diff offset, a line diff
/// (or hex context for binary content), and targeted notes for the two most
/// common drift classes — trailing-newline-matrix violations and
/// formatting-only JSON differences (§8.1).
pub fn assert_golden_bytes(name: &str, actual: impl AsRef<[u8]>) {
    assert_bytes_at(&goldens_dir(), name, actual.as_ref());
}

/// [`assert_golden_bytes`] for string output.
pub fn assert_golden_str(name: &str, actual: &str) {
    assert_golden_bytes(name, actual.as_bytes());
}

/// SEMANTIC JSON comparison against a golden fixture: order-insensitive for
/// object keys, exact for values and array order. Reports the first divergent
/// JSON path on failure.
///
/// This is deliberately weaker than [`assert_golden_bytes`] — key order,
/// indentation, and trailing newlines are invisible to it. Byte-compat gates
/// (§9.1) must use [`assert_golden_bytes`].
pub fn assert_golden_json(name: &str, actual: &Value) {
    assert_json_at(&goldens_dir(), name, actual);
}

// ---------------------------------------------------------------------------
// Internals (path-parameterized so unit tests run against temp dirs without
// touching process env).
// ---------------------------------------------------------------------------

fn join_validated(dir: &Path, name: &str) -> PathBuf {
    assert!(!name.is_empty(), "golden name must not be empty");
    assert!(
        !name.contains('\\'),
        "golden name must use '/' separators: {name:?}"
    );
    let mut path = dir.to_path_buf();
    for component in name.split('/') {
        assert!(
            !component.is_empty(),
            "golden name has an empty path component (absolute names and '//' are rejected): {name:?}"
        );
        assert!(
            component != "." && component != "..",
            "golden name must not traverse directories: {name:?}"
        );
        assert!(
            !component.contains(':'),
            "golden name component must not contain ':': {name:?}"
        );
        path.push(component);
    }
    path
}

fn read_bytes_at(dir: &Path, name: &str) -> Vec<u8> {
    let path = join_validated(dir, name);
    match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => panic!("{}", missing_golden_message(dir, name, &path, &error)),
    }
}

fn read_json_at(dir: &Path, name: &str) -> Value {
    let bytes = read_bytes_at(dir, name);
    match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => panic!("golden fixture {name:?} is not valid JSON: {error}"),
    }
}

fn assert_bytes_at(dir: &Path, name: &str, actual: &[u8]) {
    let expected = read_bytes_at(dir, name);
    if expected == actual {
        return;
    }
    let path = join_validated(dir, name);
    panic!("{}", describe_mismatch(name, &path, &expected, actual));
}

fn assert_json_at(dir: &Path, name: &str, actual: &Value) {
    let expected = read_json_at(dir, name);
    if &expected == actual {
        return;
    }
    let divergence =
        first_json_divergence(&expected, actual, "$").unwrap_or_else(|| "$".to_string());
    // Pretty-printing here is diagnostics-only output; persisted-JSON writes in
    // feature code must go through cma_core::json_io (§8.1).
    panic!(
        "golden JSON mismatch: {name:?}\nfirst divergence at {divergence}\n--- golden ---\n{}\n--- actual ---\n{}\n(semantic compare; the byte-compat gate is assert_golden_bytes)",
        serde_json::to_string_pretty(&expected).unwrap_or_else(|_| "<unprintable>".into()),
        serde_json::to_string_pretty(actual).unwrap_or_else(|_| "<unprintable>".into()),
    );
}

fn missing_golden_message(dir: &Path, name: &str, path: &Path, error: &io::Error) -> String {
    let mut message = format!(
        "golden fixture {name:?} could not be read at {}: {error}\n",
        path.display()
    );
    if dir.is_dir() {
        let mut names = Vec::new();
        collect_names(dir, dir, &mut names);
        names.sort();
        if names.is_empty() {
            message.push_str(&format!(
                "goldens directory {} exists but contains no fixtures.\n",
                dir.display()
            ));
        } else {
            const MAX_LISTED: usize = 100;
            message.push_str(&format!(
                "available goldens under {} ({}):\n",
                dir.display(),
                names.len()
            ));
            for fixture in names.iter().take(MAX_LISTED) {
                message.push_str(&format!("  - {fixture}\n"));
            }
            if names.len() > MAX_LISTED {
                message.push_str(&format!("  ... and {} more\n", names.len() - MAX_LISTED));
            }
        }
    } else {
        message.push_str(&format!(
            "goldens directory {} does not exist.\n",
            dir.display()
        ));
    }
    message.push_str(
        "Goldens are seeded from the TypeScript tool (ARCHITECTURE.md \u{a7}7 F6); \
         they are never generated by the Rust tests.",
    );
    message
}

fn collect_names(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_names(root, &path, out);
        } else if let Ok(relative) = path.strip_prefix(root) {
            let name = relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            out.push(name);
        }
    }
}

fn describe_mismatch(name: &str, path: &Path, expected: &[u8], actual: &[u8]) -> String {
    let offset = first_diff_offset(expected, actual);
    let mut out = format!(
        "golden mismatch: {name:?} ({})\nexpected {} bytes, actual {} bytes; first difference at byte offset {offset}\n",
        path.display(),
        expected.len(),
        actual.len()
    );
    if let Some(note) = trailing_newline_note(expected, actual) {
        out.push_str(note);
    }
    if let (Ok(expected_json), Ok(actual_json)) = (
        serde_json::from_slice::<Value>(expected),
        serde_json::from_slice::<Value>(actual),
    ) && expected_json == actual_json
    {
        out.push_str(
            "note: both sides parse to semantically-equal JSON — the difference is \
             formatting only (indentation, key order, or the trailing-newline matrix; \
             see ARCHITECTURE.md \u{a7}8.1). The byte-compat gate still fails.\n",
        );
    }
    match (std::str::from_utf8(expected), std::str::from_utf8(actual)) {
        (Ok(expected_text), Ok(actual_text)) => out.push_str(&text_diff(expected_text, actual_text)),
        _ => out.push_str(&hex_context(expected, actual, offset)),
    }
    out
}

fn first_diff_offset(expected: &[u8], actual: &[u8]) -> usize {
    let shared = expected.len().min(actual.len());
    for index in 0..shared {
        if expected[index] != actual[index] {
            return index;
        }
    }
    shared
}

fn trailing_newline_note(expected: &[u8], actual: &[u8]) -> Option<&'static str> {
    if expected.len() == actual.len() + 1
        && expected.ends_with(b"\n")
        && &expected[..actual.len()] == actual
    {
        Some(
            "note: actual output is MISSING the trailing newline the golden file has \
             (trailing-newline matrix, ARCHITECTURE.md \u{a7}8.1).\n",
        )
    } else if actual.len() == expected.len() + 1
        && actual.ends_with(b"\n")
        && &actual[..expected.len()] == expected
    {
        Some(
            "note: actual output HAS a trailing newline the golden file does not \
             (trailing-newline matrix, ARCHITECTURE.md \u{a7}8.1).\n",
        )
    } else {
        None
    }
}

fn text_diff(expected: &str, actual: &str) -> String {
    const MAX_SHOWN: usize = 8;
    let expected_lines: Vec<&str> = expected.split('\n').collect();
    let actual_lines: Vec<&str> = actual.split('\n').collect();

    let mut start = 0;
    while start < expected_lines.len()
        && start < actual_lines.len()
        && expected_lines[start] == actual_lines[start]
    {
        start += 1;
    }
    let mut expected_end = expected_lines.len();
    let mut actual_end = actual_lines.len();
    while expected_end > start
        && actual_end > start
        && expected_lines[expected_end - 1] == actual_lines[actual_end - 1]
    {
        expected_end -= 1;
        actual_end -= 1;
    }

    let mut out =
        String::from("line diff (- golden, + actual; lines rendered with Debug escapes):\n");
    for (index, line) in expected_lines
        .iter()
        .enumerate()
        .take(start)
        .skip(start.saturating_sub(2))
    {
        out.push_str(&format!("  {:>4} | {line:?}\n", index + 1));
    }
    for (shown, index) in (start..expected_end).enumerate() {
        if shown == MAX_SHOWN {
            out.push_str(&format!(
                "  ... {} more golden line(s) differ\n",
                expected_end - index
            ));
            break;
        }
        out.push_str(&format!("- {:>4} | {:?}\n", index + 1, expected_lines[index]));
    }
    for (shown, index) in (start..actual_end).enumerate() {
        if shown == MAX_SHOWN {
            out.push_str(&format!(
                "  ... {} more actual line(s) differ\n",
                actual_end - index
            ));
            break;
        }
        out.push_str(&format!("+ {:>4} | {:?}\n", index + 1, actual_lines[index]));
    }
    out
}

fn hex_context(expected: &[u8], actual: &[u8], offset: usize) -> String {
    let start = offset.saturating_sub(16);
    format!(
        "binary content; bytes around offset {offset}:\n  golden[{start}..]: {}\n  actual[{start}..]: {}\n",
        hex_slice(expected, start, 48),
        hex_slice(actual, start, 48)
    )
}

fn hex_slice(bytes: &[u8], start: usize, len: usize) -> String {
    if start >= bytes.len() {
        return "<past end>".to_string();
    }
    let end = (start + len).min(bytes.len());
    bytes[start..end]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn first_json_divergence(expected: &Value, actual: &Value, path: &str) -> Option<String> {
    match (expected, actual) {
        (Value::Object(expected_map), Value::Object(actual_map)) => {
            for (key, expected_value) in expected_map {
                match actual_map.get(key) {
                    None => return Some(format!("{path}.{key}: missing from actual")),
                    Some(actual_value) => {
                        if let Some(divergence) = first_json_divergence(
                            expected_value,
                            actual_value,
                            &format!("{path}.{key}"),
                        ) {
                            return Some(divergence);
                        }
                    }
                }
            }
            for key in actual_map.keys() {
                if !expected_map.contains_key(key) {
                    return Some(format!("{path}.{key}: unexpected key in actual"));
                }
            }
            None
        }
        (Value::Array(expected_items), Value::Array(actual_items)) => {
            for (index, (expected_value, actual_value)) in
                expected_items.iter().zip(actual_items.iter()).enumerate()
            {
                if let Some(divergence) =
                    first_json_divergence(expected_value, actual_value, &format!("{path}[{index}]"))
                {
                    return Some(divergence);
                }
            }
            if expected_items.len() != actual_items.len() {
                return Some(format!(
                    "{path}: array length {} (golden) vs {} (actual)",
                    expected_items.len(),
                    actual_items.len()
                ));
            }
            None
        }
        _ if expected == actual => None,
        _ => Some(format!(
            "{path}: golden {} vs actual {}",
            short_json(expected),
            short_json(actual)
        )),
    }
}

fn short_json(value: &Value) -> String {
    let text = value.to_string();
    if text.chars().count() > 80 {
        let truncated: String = text.chars().take(80).collect();
        format!("{truncated}\u{2026}")
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::EnvSandbox;
    use serde_json::json;
    use serial_test::serial;

    fn panic_message<F: FnOnce()>(operation: F) -> String {
        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation))
            .expect_err("expected the operation to panic");
        if let Some(text) = payload.downcast_ref::<String>() {
            text.clone()
        } else if let Some(text) = payload.downcast_ref::<&str>() {
            (*text).to_string()
        } else {
            "<non-string panic payload>".to_string()
        }
    }

    #[test]
    fn reads_and_asserts_equal_bytes_including_subdirectories() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("fixtures")).unwrap();
        let content = b"{\n  \"version\": 3\n}\n";
        fs::write(dir.path().join("fixtures").join("sample.json"), content).unwrap();

        assert_eq!(read_bytes_at(dir.path(), "fixtures/sample.json"), content);
        assert_bytes_at(dir.path(), "fixtures/sample.json", content); // no panic
    }

    #[test]
    fn mismatch_reports_offset_and_line_diff() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("g.txt"), "line one\nline two\nline three\n").unwrap();

        let message = panic_message(|| {
            assert_bytes_at(dir.path(), "g.txt", b"line one\nline 2wo\nline three\n");
        });
        assert!(message.contains("golden mismatch"), "{message}");
        assert!(
            message.contains("first difference at byte offset 14"),
            "{message}"
        );
        assert!(message.contains("- "), "{message}");
        assert!(message.contains("+ "), "{message}");
        assert!(message.contains("line two"), "{message}");
        assert!(message.contains("line 2wo"), "{message}");
    }

    #[test]
    fn trailing_newline_difference_is_called_out_both_ways() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("t.txt"), "abc\n").unwrap();
        let message = panic_message(|| assert_bytes_at(dir.path(), "t.txt", b"abc"));
        assert!(message.contains("MISSING the trailing newline"), "{message}");

        fs::write(dir.path().join("u.txt"), "abc").unwrap();
        let message = panic_message(|| assert_bytes_at(dir.path(), "u.txt", b"abc\n"));
        assert!(message.contains("HAS a trailing newline"), "{message}");
    }

    #[test]
    fn formatting_only_json_difference_gets_a_semantic_note() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("j.json"), "{\n  \"a\": 1\n}\n").unwrap();
        let message = panic_message(|| assert_bytes_at(dir.path(), "j.json", b"{\"a\":1}"));
        assert!(message.contains("semantically-equal JSON"), "{message}");
    }

    #[test]
    fn semantically_different_json_gets_no_formatting_note() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("j.json"), "{\"a\":1}").unwrap();
        let message = panic_message(|| assert_bytes_at(dir.path(), "j.json", b"{\"a\":2}"));
        assert!(!message.contains("semantically-equal JSON"), "{message}");
    }

    #[test]
    fn binary_mismatch_falls_back_to_hex_context() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("b.bin"), [0x00u8, 0xff, 0xfe]).unwrap();
        let message =
            panic_message(|| assert_bytes_at(dir.path(), "b.bin", &[0x00u8, 0xff, 0x00][..]));
        assert!(message.contains("binary content"), "{message}");
        assert!(message.contains("ff fe"), "{message}");
    }

    #[test]
    fn missing_fixture_lists_available_goldens_and_seeding_note() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("present.json"), b"{}").unwrap();

        let message = panic_message(|| {
            read_bytes_at(dir.path(), "absent.json");
        });
        assert!(message.contains("could not be read"), "{message}");
        assert!(message.contains("present.json"), "{message}");
        assert!(message.contains("seeded from the TypeScript tool"), "{message}");
    }

    #[test]
    fn missing_goldens_directory_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let nonexistent = dir.path().join("no-goldens-here");
        let message = panic_message(|| {
            read_bytes_at(&nonexistent, "anything.json");
        });
        assert!(message.contains("does not exist"), "{message}");
    }

    #[test]
    fn golden_names_are_validated() {
        let dir = tempfile::tempdir().unwrap();
        let cases: [(&str, &str); 6] = [
            ("", "must not be empty"),
            ("a\\b", "'/' separators"),
            ("../escape", "must not traverse"),
            ("a/./b", "must not traverse"),
            ("a//b", "empty path component"),
            ("c:/evil", "must not contain ':'"),
        ];
        for (name, expected_fragment) in cases {
            let message = panic_message(|| {
                join_validated(dir.path(), name);
            });
            assert!(
                message.contains(expected_fragment),
                "name {name:?}: {message}"
            );
        }
    }

    #[test]
    fn json_divergence_reports_first_divergent_path() {
        let expected = json!({ "a": { "b": 1 }, "c": [1, 2] });
        assert_eq!(
            first_json_divergence(&expected, &json!({ "a": { "b": 2 }, "c": [1, 2] }), "$"),
            Some("$.a.b: golden 1 vs actual 2".to_string())
        );
        assert_eq!(
            first_json_divergence(&expected, &json!({ "a": { "b": 1 }, "c": [1] }), "$"),
            Some("$.c: array length 2 (golden) vs 1 (actual)".to_string())
        );
        assert_eq!(
            first_json_divergence(&expected, &json!({ "a": { "b": 1 } }), "$"),
            Some("$.c: missing from actual".to_string())
        );
        assert_eq!(
            first_json_divergence(
                &expected,
                &json!({ "a": { "b": 1 }, "c": [1, 2], "d": true }),
                "$"
            ),
            Some("$.d: unexpected key in actual".to_string())
        );
        assert_eq!(first_json_divergence(&expected, &expected.clone(), "$"), None);
    }

    #[test]
    fn assert_json_is_semantic_and_reports_path() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("s.json"), "{\"a\":1,\"b\":2}").unwrap();
        // Key order and formatting are invisible to the semantic compare.
        assert_json_at(dir.path(), "s.json", &json!({ "b": 2, "a": 1 }));

        let message =
            panic_message(|| assert_json_at(dir.path(), "s.json", &json!({ "a": 9, "b": 2 })));
        assert!(message.contains("first divergence at $.a"), "{message}");
        assert!(message.contains("byte-compat gate"), "{message}");
    }

    #[test]
    #[serial(env)]
    fn env_override_redirects_goldens_dir() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("env.json"), b"{}").unwrap();

        let mut sandbox = EnvSandbox::new();
        sandbox.set_var(GOLDENS_DIR_ENV, dir.path());
        assert_eq!(goldens_dir(), dir.path());
        assert_eq!(golden_path("env.json"), dir.path().join("env.json"));
        assert_eq!(read_golden_bytes("env.json"), b"{}");
        assert_eq!(read_golden_string("env.json"), "{}");
        assert_eq!(read_golden_json("env.json"), json!({}));
        assert_golden_bytes("env.json", b"{}");
        assert_golden_str("env.json", "{}");
        assert_golden_json("env.json", &json!({}));
        assert_eq!(available_goldens(), vec!["env.json".to_string()]);
        assert_eq!(
            try_read_golden_bytes("missing.json")
                .unwrap_err()
                .kind(),
            io::ErrorKind::NotFound
        );
    }

    #[test]
    #[serial(env)]
    fn default_goldens_dir_points_into_this_crate() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var(GOLDENS_DIR_ENV);
        let dir = goldens_dir();
        assert!(dir.ends_with("goldens"), "{}", dir.display());
        assert!(
            dir.parent()
                .and_then(|parent| parent.file_name())
                .is_some_and(|name| name == "testkit"),
            "{}",
            dir.display()
        );
    }
}
