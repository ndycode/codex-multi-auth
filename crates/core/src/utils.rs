//! Port of `lib/utils.ts` — consolidated tiny utility functions.
//!
//! Note: TS `isAbortError` has no Rust equivalent here — abort/timeout
//! detection is handled by `tokio::time::timeout` / request-layer error
//! classification (ARCHITECTURE §6.1 deliberately omits it from this file).

use serde_json::Value;

/// Type guard for plain objects (TS `isRecord`): in `serde_json::Value` terms,
/// only `Value::Object` qualifies (arrays and null are NOT records).
pub fn is_record(value: &Value) -> bool {
    value.is_object()
}

/// Returns the current wall-clock timestamp in milliseconds since the Unix
/// epoch (TS `nowMs`, a `Date.now()` wrapper kept as a test seam — for
/// injectable time use [`crate::clock::Clock`]).
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Safely converts a JSON value to a string representation (TS
/// `toStringValue`):
/// - strings pass through unquoted;
/// - `null` → `"null"`;
/// - objects/arrays → compact `JSON.stringify` output;
/// - numbers/booleans → their JS `String(...)` form.
///
/// For the JS `undefined → "undefined"` case (no JSON equivalent) see
/// [`to_string_value_opt`].
pub fn to_string_value(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        Value::Object(_) | Value::Array(_) => serde_json::to_string(value)
            .unwrap_or_else(|_| "[object Object]".to_string()),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
    }
}

/// [`to_string_value`] over an optional value: `None` (the JS `undefined`
/// case) → `"undefined"`.
pub fn to_string_value_opt(value: Option<&Value>) -> String {
    match value {
        Some(value) => to_string_value(value),
        None => "undefined".to_string(),
    }
}

/// Async sleep for the given number of milliseconds (TS `sleep`, a promisified
/// `setTimeout`).
pub async fn sleep(ms: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn is_record_accepts_only_objects() {
        assert!(is_record(&json!({})));
        assert!(is_record(&json!({"key": "value"})));
        assert!(is_record(&json!({"nested": {"obj": true}})));

        assert!(!is_record(&Value::Null));
        assert!(!is_record(&json!([])));
        assert!(!is_record(&json!([1, 2, 3])));
        assert!(!is_record(&json!("string")));
        assert!(!is_record(&json!(123)));
        assert!(!is_record(&json!(true)));
    }

    #[test]
    fn now_ms_returns_a_plausible_epoch_timestamp() {
        let now = now_ms();
        // 2020-01-01 in ms — anything earlier means we returned seconds or garbage.
        assert!(now > 1_577_836_800_000, "now_ms() = {now}");
    }

    #[test]
    fn to_string_value_returns_strings_unchanged() {
        assert_eq!(to_string_value(&json!("hello")), "hello");
        assert_eq!(to_string_value(&json!("")), "");
        assert_eq!(to_string_value(&json!("123")), "123");
    }

    #[test]
    fn to_string_value_converts_null_and_undefined() {
        assert_eq!(to_string_value(&Value::Null), "null");
        assert_eq!(to_string_value_opt(None), "undefined");
        assert_eq!(to_string_value_opt(Some(&json!("x"))), "x");
    }

    #[test]
    // 3.14 is a decimal-formatting sample (mirrors the TS test literal), not an
    // approximation of PI.
    #[allow(clippy::approx_constant)]
    fn to_string_value_converts_numbers_and_booleans() {
        assert_eq!(to_string_value(&json!(123)), "123");
        assert_eq!(to_string_value(&json!(0)), "0");
        assert_eq!(to_string_value(&json!(-42)), "-42");
        assert_eq!(to_string_value(&json!(3.14)), "3.14");
        assert_eq!(to_string_value(&json!(true)), "true");
        assert_eq!(to_string_value(&json!(false)), "false");
    }

    #[test]
    fn to_string_value_json_stringifies_objects_and_arrays() {
        assert_eq!(to_string_value(&json!({})), "{}");
        assert_eq!(to_string_value(&json!({"key": "value"})), r#"{"key":"value"}"#);
        assert_eq!(to_string_value(&json!([1, 2, 3])), "[1,2,3]");
        assert_eq!(
            to_string_value(&json!({"a": {"b": {"c": 1}}})),
            r#"{"a":{"b":{"c":1}}}"#
        );
    }

    #[tokio::test]
    async fn sleep_resolves_after_the_given_duration() {
        let start = std::time::Instant::now();
        sleep(25).await;
        // Timer granularity varies by platform; only assert the lower bound.
        assert!(start.elapsed() >= std::time::Duration::from_millis(20));
    }

    #[tokio::test]
    async fn sleep_zero_resolves_immediately() {
        sleep(0).await;
    }
}
