//! Client-key authentication for the runtime rotation proxy — port of the
//! auth half of `lib/runtime-rotation-proxy.ts` (`safeEqual`,
//! `isAuthorizedClient`) plus the per-process key generator
//! (`createRuntimeRotationProxyClientApiKey` from `scripts/codex.js`).
//!
//! Spec 04 §9 (gotcha 22): the comparison is constant-time with an explicit
//! length-equality check, and client auth runs BEFORE path routing so an
//! unknown caller can never enumerate endpoints (always 401, never 404).

use http::HeaderMap;
use rand::TryRngCore;
use subtle::ConstantTimeEq;

/// TS `createRuntimeRotationProxyClientApiKey()` (`scripts/codex.js`):
/// `randomBytes(32).toString("hex")` — 64 lowercase hex chars from an
/// OS-CSPRNG.
pub fn create_runtime_rotation_proxy_client_api_key() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .expect("OS RNG unavailable");
    let mut out = String::with_capacity(64);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// TS `safeEqual(left, right)` — constant-time compare over buffers padded to
/// `max(left.len, right.len, 1)`, AND-ed with a length-equality check. The
/// padding keeps the constant-time comparison running over equal-length
/// inputs so a length mismatch cannot short-circuit it.
pub fn safe_equal(left: &str, right: &str) -> bool {
    let left_bytes = left.as_bytes();
    let right_bytes = right.as_bytes();
    let compare_length = left_bytes.len().max(right_bytes.len()).max(1);
    let mut padded_left = vec![0u8; compare_length];
    let mut padded_right = vec![0u8; compare_length];
    padded_left[..left_bytes.len()].copy_from_slice(left_bytes);
    padded_right[..right_bytes.len()].copy_from_slice(right_bytes);
    let equal: bool = padded_left.ct_eq(&padded_right).into();
    equal && left_bytes.len() == right_bytes.len()
}

/// TS private `isAuthorizedClient(headers, clientApiKey)` — accepts
/// `Authorization: Bearer <key>` (scheme case-insensitive, value trimmed;
/// regex `/^Bearer\s+(.+)$/i`) or `x-api-key: <key>`, both compared with
/// [`safe_equal`].
pub fn is_authorized_client(headers: &HeaderMap, client_api_key: &str) -> bool {
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if let Some(bearer) = parse_bearer(authorization)
        && !bearer.is_empty()
        && safe_equal(bearer, client_api_key)
    {
        return true;
    }
    match headers.get("x-api-key").and_then(|value| value.to_str().ok()) {
        Some(api_key) => safe_equal(api_key, client_api_key),
        None => false,
    }
}

/// `/^Bearer\s+(.+)$/i` — scheme match is case-insensitive, at least one
/// whitespace char, remainder captured then trimmed (the TS `.trim()` on the
/// capture).
fn parse_bearer(authorization: &str) -> Option<&str> {
    let rest = strip_prefix_ignore_ascii_case(authorization, "Bearer")?;
    // `\s+` — require at least one leading whitespace char after the scheme.
    if !rest.starts_with(|c: char| c.is_whitespace()) {
        return None;
    }
    let captured = rest.trim_start_matches(|c: char| c.is_whitespace());
    // `(.+)` — the capture must be non-empty before trimming.
    if captured.is_empty() {
        return None;
    }
    Some(captured.trim())
}

fn strip_prefix_ignore_ascii_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    if value.len() >= prefix.len() && value[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&value[prefix.len()..])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                name.parse::<http::header::HeaderName>().unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn generated_client_keys_are_64_hex_chars_and_unique() {
        let first = create_runtime_rotation_proxy_client_api_key();
        let second = create_runtime_rotation_proxy_client_api_key();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(first.bytes().all(|b| !b.is_ascii_uppercase()));
        assert_ne!(first, second);
    }

    #[test]
    fn safe_equal_matches_only_identical_strings() {
        assert!(safe_equal("runtime-secret", "runtime-secret"));
        assert!(!safe_equal("runtime-secret", "runtime-secreT"));
        // Mismatched lengths compare over padded buffers and return false
        // (the TS safe-equal test asserts timingSafeEqual still ran on
        // equal-length padded buffers — structurally guaranteed here by
        // ct_eq over the padded vectors).
        assert!(!safe_equal("short", "runtime-secret-with-longer-length"));
        assert!(!safe_equal("runtime-secret-with-longer-length", "short"));
    }

    #[test]
    fn safe_equal_handles_empty_inputs_like_ts() {
        // TS: compareLength = max(0, 0, 1) = 1 — two zero buffers are equal
        // and the length check (0 === 0) passes.
        assert!(safe_equal("", ""));
        assert!(!safe_equal("", "x"));
        assert!(!safe_equal("x", ""));
    }

    #[test]
    fn authorizes_bearer_case_insensitively_and_trims() {
        let key = "runtime-secret";
        assert!(is_authorized_client(
            &headers(&[("authorization", "Bearer runtime-secret")]),
            key
        ));
        assert!(is_authorized_client(
            &headers(&[("authorization", "bearer runtime-secret")]),
            key
        ));
        assert!(is_authorized_client(
            &headers(&[("authorization", "BEARER   runtime-secret  ")]),
            key
        ));
        // No whitespace after the scheme -> not a bearer credential.
        assert!(!is_authorized_client(
            &headers(&[("authorization", "Bearerruntime-secret")]),
            key
        ));
        assert!(!is_authorized_client(
            &headers(&[("authorization", "Basic runtime-secret")]),
            key
        ));
        assert!(!is_authorized_client(&headers(&[]), key));
    }

    #[test]
    fn authorizes_via_x_api_key_header() {
        let key = "runtime-secret";
        assert!(is_authorized_client(
            &headers(&[("x-api-key", "runtime-secret")]),
            key
        ));
        // x-api-key is NOT trimmed in TS (`headers.get` returns the raw value).
        assert!(!is_authorized_client(
            &headers(&[("x-api-key", " runtime-secret ")]),
            key
        ));
        assert!(!is_authorized_client(
            &headers(&[("x-api-key", "wrong")]),
            key
        ));
    }

    #[test]
    fn bearer_takes_precedence_but_falls_back_to_x_api_key() {
        let key = "runtime-secret";
        // Wrong bearer + right x-api-key still authorizes (TS falls through).
        assert!(is_authorized_client(
            &headers(&[("authorization", "Bearer wrong"), ("x-api-key", key)]),
            key
        ));
    }
}
