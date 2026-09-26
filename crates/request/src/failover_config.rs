//! Port of `lib/request/failover-config.ts` — env parsing helpers for the
//! failover mode + numeric tunables (spec 06 §12).
//!
//! Gotcha (spec 06 §27 item 12): [`parse_failover_mode`] defaults every
//! unknown/absent string to `Balanced`, while the failure-policy INPUT default
//! is `Aggressive`. Both are deliberate.

use crate::failure_policy::FailoverMode;

/// TS `parseFailoverMode(value)` — trim + lowercase; only `"aggressive"` and
/// `"conservative"` pass through, everything else (including `None`) is
/// `Balanced`.
pub fn parse_failover_mode(value: Option<&str>) -> FailoverMode {
    let normalized = value.unwrap_or("").trim().to_lowercase();
    match normalized.as_str() {
        "aggressive" => FailoverMode::Aggressive,
        "conservative" => FailoverMode::Conservative,
        _ => FailoverMode::Balanced,
    }
}

/// TS `parseEnvInt(value)` — `Number.parseInt(v, 10)` semantics: skip leading
/// whitespace, optional sign, then base-10 digits (trailing garbage ignored).
/// No digits => `None`. Negative/zero values pass through as-is.
pub fn parse_env_int(value: Option<&str>) -> Option<i64> {
    let value = value?;
    let trimmed = value.trim_start();
    let (negative, rest) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    // parseInt keeps consuming digits and JS numbers lose precision beyond
    // 2^53; saturate rather than error for absurd inputs.
    let magnitude = digits.parse::<i64>().unwrap_or(i64::MAX);
    Some(if negative { -magnitude } else { magnitude })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_failover_mode_with_balanced_fallback() {
        assert_eq!(parse_failover_mode(Some("aggressive")), FailoverMode::Aggressive);
        assert_eq!(
            parse_failover_mode(Some(" conservative ")),
            FailoverMode::Conservative
        );
        assert_eq!(parse_failover_mode(Some("weird")), FailoverMode::Balanced);
        assert_eq!(parse_failover_mode(None), FailoverMode::Balanced);
        assert_eq!(parse_failover_mode(Some("AGGRESSIVE")), FailoverMode::Aggressive);
    }

    #[test]
    fn parses_finite_integers_from_env_values() {
        assert_eq!(parse_env_int(Some("42")), Some(42));
        assert_eq!(parse_env_int(Some("08")), Some(8));
        assert_eq!(parse_env_int(None), None);
        assert_eq!(parse_env_int(Some("abc")), None);
        // parseInt semantics: trailing garbage ignored, sign honored.
        assert_eq!(parse_env_int(Some(" 42abc")), Some(42));
        assert_eq!(parse_env_int(Some("-7")), Some(-7));
        assert_eq!(parse_env_int(Some("+9")), Some(9));
        assert_eq!(parse_env_int(Some("")), None);
    }
}
