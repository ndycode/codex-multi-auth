//! Port of `lib/env-parsing.ts` — shared helper for parsing string
//! environment variables.
//!
//! Pulled out of three near-identical local copies (lib/config.ts,
//! lib/refresh-lease.ts, lib/codex-manager/commands/rotation.ts) so every call
//! site agrees on accepted truthy/falsy literals and on what an unparseable
//! value returns.

const TRUE_VALUES: [&str; 3] = ["1", "true", "yes"];
const FALSE_VALUES: [&str; 3] = ["0", "false", "no"];

/// Parses a boolean environment-variable string (TS `parseBooleanEnv`).
///
/// Accepts (case-insensitive, trimmed): `"1"`/`"0"`, `"true"`/`"false"`,
/// `"yes"`/`"no"`. Returns `None` for `None` input, an empty/whitespace-only
/// string, or any value that doesn't match an accepted literal — letting
/// callers fall back to default-handling logic.
pub fn parse_boolean_env(value: Option<&str>) -> Option<bool> {
    let value = value?;
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    if TRUE_VALUES.contains(&normalized.as_str()) {
        return Some(true);
    }
    if FALSE_VALUES.contains(&normalized.as_str()) {
        return Some(false);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_six_accepted_literals() {
        assert_eq!(parse_boolean_env(Some("1")), Some(true));
        assert_eq!(parse_boolean_env(Some("0")), Some(false));
        assert_eq!(parse_boolean_env(Some("true")), Some(true));
        assert_eq!(parse_boolean_env(Some("false")), Some(false));
        assert_eq!(parse_boolean_env(Some("yes")), Some(true));
        assert_eq!(parse_boolean_env(Some("no")), Some(false));
    }

    #[test]
    fn tolerates_case_and_whitespace() {
        assert_eq!(parse_boolean_env(Some("TRUE")), Some(true));
        assert_eq!(parse_boolean_env(Some("True")), Some(true));
        assert_eq!(parse_boolean_env(Some("FALSE")), Some(false));
        assert_eq!(parse_boolean_env(Some("YES")), Some(true));
        assert_eq!(parse_boolean_env(Some("No")), Some(false));
        assert_eq!(parse_boolean_env(Some("  true  ")), Some(true));
        assert_eq!(parse_boolean_env(Some("\tfalse\n")), Some(false));
        assert_eq!(parse_boolean_env(Some("  1 ")), Some(true));
        assert_eq!(parse_boolean_env(Some("  0 ")), Some(false));
    }

    #[test]
    fn returns_none_for_unset_empty_or_unrecognised() {
        assert_eq!(parse_boolean_env(None), None);
        for input in [
            "", "   ", "\t\n", "maybe", "enabled", "disabled", "on", "off", "2", "-1", "null",
            "undefined",
        ] {
            assert_eq!(parse_boolean_env(Some(input)), None, "input {input:?}");
        }
    }

    #[test]
    fn supports_nullish_coalescing_semantics() {
        let fallback = true;
        assert!(parse_boolean_env(Some("garbage")).unwrap_or(fallback));
        assert!(parse_boolean_env(None).unwrap_or(fallback));
        assert!(parse_boolean_env(Some("")).unwrap_or(fallback));
        // An explicitly parsed false wins over the default.
        assert!(!parse_boolean_env(Some("false")).unwrap_or(fallback));
        assert!(!parse_boolean_env(Some("0")).unwrap_or(fallback));
    }
}
