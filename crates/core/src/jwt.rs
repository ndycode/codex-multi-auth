//! Port of `decodeJWT` from `lib/auth/auth.ts`.
//!
//! UNVERIFIED JWT payload decode: base64url -> base64 normalization with manual
//! `=` padding, UTF-8 decode, JSON parse. No signature verification (by
//! design — the tokens come straight from the OAuth provider over TLS and are
//! only mined for display/routing hints, never trusted for authorization).
//!
//! Behavior contract (spec 07 §1 / gotcha 21):
//! - the token must have EXACTLY 3 dot-separated segments;
//! - any error at any step returns `None`;
//! - do NOT pull in a JWT crate.

use base64::Engine;
use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};

/// Standard-alphabet base64 engine tuned to be as forgiving as Node's
/// `Buffer.from(str, "base64")` for the inputs this decoder produces:
/// indifferent to padding and tolerant of non-zero trailing bits.
const NODE_LIKE_BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// Decode a JWT's payload segment to raw JSON without verifying the signature.
///
/// This is the workhorse used by `token_utils` (which mines arbitrary,
/// schema-less claims). Returns `None` on any structural, base64, UTF-8 or
/// JSON failure — mirroring the TS `try { … } catch { return null; }`.
pub fn decode_jwt_value(token: &str) -> Option<serde_json::Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload = parts[1];
    // base64url -> base64: `-` -> `+`, `_` -> `/`, then pad to a multiple of 4.
    let normalized = payload.replace('-', "+").replace('_', "/");
    let pad = (4 - normalized.len() % 4) % 4;
    let padded = format!("{normalized}{}", "=".repeat(pad));
    let bytes = NODE_LIKE_BASE64.decode(padded.as_bytes()).ok()?;
    // Node's `buffer.toString("utf-8")` is lossy (invalid sequences become
    // U+FFFD instead of failing); mirror that so a byte-level oddity in an
    // otherwise-parseable payload does not flip the result to None.
    let decoded = String::from_utf8_lossy(&bytes);
    serde_json::from_str(&decoded).ok()
}

/// Decode a JWT payload into the typed [`crate::types::JWTPayload`] model.
///
/// Equivalent to the TS `decodeJWT(token): JWTPayload | null`. The payload is
/// decoded unverified; unknown claims are preserved by the `JWTPayload` model.
pub fn decode_jwt(token: &str) -> Option<crate::types::JWTPayload> {
    let value = decode_jwt_value(token)?;
    serde_json::from_value(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use serde_json::{Value, json};

    fn b64url(data: &str) -> String {
        URL_SAFE_NO_PAD.encode(data.as_bytes())
    }

    fn make_jwt(payload: &Value) -> String {
        let header = json!({ "alg": "none", "typ": "JWT" });
        format!(
            "{}.{}.{}",
            b64url(&header.to_string()),
            b64url(&payload.to_string()),
            "sig"
        )
    }

    #[test]
    fn decodes_a_valid_jwt_payload() {
        let payload = json!({
            "https://api.openai.com/auth": { "chatgpt_account_id": "acc_123456" },
            "email": "user@example.com",
        });
        let decoded = decode_jwt_value(&make_jwt(&payload)).expect("decodes");
        assert_eq!(
            decoded["https://api.openai.com/auth"]["chatgpt_account_id"],
            json!("acc_123456")
        );
        assert_eq!(decoded["email"], json!("user@example.com"));
    }

    #[test]
    fn requires_exactly_three_segments() {
        let payload = json!({ "a": 1 });
        let two = format!("{}.{}", b64url("{}"), b64url(&payload.to_string()));
        assert!(decode_jwt_value(&two).is_none());
        let four = format!("{}.extra", make_jwt(&payload));
        assert!(decode_jwt_value(&four).is_none());
        assert!(decode_jwt_value("").is_none());
        assert!(decode_jwt_value("only-one-segment").is_none());
    }

    #[test]
    fn returns_none_for_garbage_payload_segment() {
        assert!(decode_jwt_value("aaa.!!!not-base64%%%.ccc").is_none());
        // Valid base64 but not JSON.
        let not_json = format!("aaa.{}.ccc", b64url("this is not json"));
        assert!(decode_jwt_value(&not_json).is_none());
    }

    #[test]
    fn handles_every_padding_remainder() {
        // Payload lengths that produce base64url lengths with remainders 0/2/3
        // (remainder 1 is impossible for canonical base64) all decode.
        for filler_len in 0..12usize {
            let payload = json!({ "k": "x".repeat(filler_len) });
            let decoded = decode_jwt_value(&make_jwt(&payload)).expect("decodes");
            assert_eq!(decoded["k"], json!("x".repeat(filler_len)));
        }
    }

    #[test]
    fn handles_url_safe_alphabet_characters() {
        // Multi-byte UTF-8 content forces bytes whose standard-base64 encoding
        // contains `+`/`/`; the url-safe form uses `-`/`_`, exercising the
        // normalization path.
        let payload = json!({ "name": "日本語テキスト😀🌍", "meta": "ÿþý" });
        let token = make_jwt(&payload);
        let decoded = decode_jwt_value(&token).expect("decodes");
        assert_eq!(decoded["name"], json!("日本語テキスト😀🌍"));
        assert_eq!(decoded["meta"], json!("ÿþý"));
    }

    #[test]
    fn non_object_json_payload_still_parses_as_value() {
        // JSON.parse accepts any JSON value; the raw-value decoder mirrors it.
        let token = format!("aaa.{}.ccc", b64url("123"));
        assert_eq!(decode_jwt_value(&token), Some(json!(123)));
    }
}
