//! Token / OAuth response schemas — port of the token half of
//! `lib/schemas.ts` (spec 01 §3.3).
//!
//! - `TokenResult` is the discriminated union on the `type` tag
//!   (`"success"` / `"failed"`); an unknown tag fails the parse.
//! - `TokenSuccess.expires` and `OAuthTokenResponse.expires_in` are
//!   `z.number().int().positive()` — zero, negative or fractional values
//!   fail (I1: never mint an already-expired token).
//! - `access`/`refresh`/`access_token` are `z.string().min(1)`.

use serde::{Deserialize, Serialize};

use super::parse::{de_int_positive_strict, de_opt_number_lenient, de_opt_strict, de_string_min1};

/// Token failure reason codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TokenFailureReason {
    #[serde(rename = "http_error")]
    HttpError,
    #[serde(rename = "invalid_response")]
    InvalidResponse,
    #[serde(rename = "network_error")]
    NetworkError,
    #[serde(rename = "missing_refresh")]
    MissingRefresh,
    #[serde(rename = "timeout")]
    Timeout,
    #[serde(rename = "unknown")]
    Unknown,
}

impl TokenFailureReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::HttpError => "http_error",
            Self::InvalidResponse => "invalid_response",
            Self::NetworkError => "network_error",
            Self::MissingRefresh => "missing_refresh",
            Self::Timeout => "timeout",
            Self::Unknown => "unknown",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "http_error" => Some(Self::HttpError),
            "invalid_response" => Some(Self::InvalidResponse),
            "network_error" => Some(Self::NetworkError),
            "missing_refresh" => Some(Self::MissingRefresh),
            "timeout" => Some(Self::Timeout),
            "unknown" => Some(Self::Unknown),
            _ => None,
        }
    }
}

impl std::fmt::Display for TokenFailureReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Successful token exchange result (`type: "success"` — the tag is carried
/// by [`TokenResult`]).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TokenSuccess {
    /// Required, non-empty.
    #[serde(deserialize_with = "de_string_min1")]
    pub access: String,
    /// Required, non-empty.
    #[serde(deserialize_with = "de_string_min1")]
    pub refresh: String,
    /// Required positive integer (epoch ms expiry).
    #[serde(deserialize_with = "de_int_positive_strict")]
    pub expires: i64,
    #[serde(
        rename = "idToken",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub id_token: Option<String>,
    #[serde(
        rename = "multiAccount",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub multi_account: Option<bool>,
}

/// Failed token exchange result (`type: "failed"` — the tag is carried by
/// [`TokenResult`]).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TokenFailure {
    #[serde(
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub reason: Option<TokenFailureReason>,
    #[serde(
        rename = "statusCode",
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub status_code: Option<i64>,
    #[serde(
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub message: Option<String>,
}

/// Token result — discriminated union of success/failure on the `type` tag.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TokenResult {
    #[serde(rename = "success")]
    Success(TokenSuccess),
    #[serde(rename = "failed")]
    Failed(TokenFailure),
}

impl TokenResult {
    /// The wire value of the `type` tag.
    pub fn type_str(&self) -> &'static str {
        match self {
            Self::Success(_) => "success",
            Self::Failed(_) => "failed",
        }
    }

    pub fn is_success(&self) -> bool {
        matches!(self, Self::Success(_))
    }

    pub fn as_success(&self) -> Option<&TokenSuccess> {
        match self {
            Self::Success(success) => Some(success),
            Self::Failed(_) => None,
        }
    }

    pub fn as_failure(&self) -> Option<&TokenFailure> {
        match self {
            Self::Success(_) => None,
            Self::Failed(failure) => Some(failure),
        }
    }
}

impl From<TokenSuccess> for TokenResult {
    fn from(value: TokenSuccess) -> Self {
        Self::Success(value)
    }
}

impl From<TokenFailure> for TokenResult {
    fn from(value: TokenFailure) -> Self {
        Self::Failed(value)
    }
}

/// OAuth token response from OpenAI (token endpoint validation boundary).
/// Field names are already snake_case on the wire — no renames.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OAuthTokenResponse {
    /// Required, non-empty.
    #[serde(deserialize_with = "de_string_min1")]
    pub access_token: String,
    #[serde(
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub refresh_token: Option<String>,
    /// Required positive integer (seconds).
    #[serde(deserialize_with = "de_int_positive_strict")]
    pub expires_in: i64,
    #[serde(
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub id_token: Option<String>,
    #[serde(
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub token_type: Option<String>,
    #[serde(
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub scope: Option<String>,
}

// ============================================================================
// Tests (ported from test/schemas.test.ts token/OAuth suites)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_success() -> serde_json::Value {
        json!({
            "type": "success",
            "access": "access_token_123",
            "refresh": "refresh_token_456",
            "expires": 1700003600000i64,
        })
    }

    #[test]
    fn accepts_valid_success() {
        let result: TokenResult = serde_json::from_value(valid_success()).expect("parses");
        let success = result.as_success().expect("success variant");
        assert_eq!(success.access, "access_token_123");
        assert_eq!(success.expires, 1_700_003_600_000);
    }

    #[test]
    fn accepts_success_with_optional_fields() {
        let mut value = valid_success();
        value["idToken"] = json!("id_token_789");
        value["multiAccount"] = json!(true);
        let result: TokenResult = serde_json::from_value(value).expect("parses");
        let success = result.as_success().unwrap();
        assert_eq!(success.id_token.as_deref(), Some("id_token_789"));
        assert_eq!(success.multi_account, Some(true));
    }

    #[test]
    fn rejects_empty_access_token() {
        let mut value = valid_success();
        value["access"] = json!("");
        assert!(serde_json::from_value::<TokenResult>(value).is_err());
    }

    #[test]
    fn rejects_empty_refresh_token() {
        let mut value = valid_success();
        value["refresh"] = json!("");
        assert!(serde_json::from_value::<TokenResult>(value).is_err());
    }

    #[test]
    fn accepts_minimal_failure() {
        let result: TokenResult =
            serde_json::from_value(json!({ "type": "failed" })).expect("parses");
        assert!(!result.is_success());
        assert_eq!(result.type_str(), "failed");
    }

    #[test]
    fn accepts_failure_with_all_optional_fields() {
        let result: TokenResult = serde_json::from_value(json!({
            "type": "failed",
            "reason": "http_error",
            "statusCode": 401,
            "message": "Unauthorized",
        }))
        .expect("parses");
        let failure = result.as_failure().unwrap();
        assert_eq!(failure.reason, Some(TokenFailureReason::HttpError));
        assert_eq!(failure.status_code, Some(401));
        assert_eq!(failure.message.as_deref(), Some("Unauthorized"));
    }

    #[test]
    fn rejects_invalid_failure_reason() {
        let result: Result<TokenResult, _> =
            serde_json::from_value(json!({ "type": "failed", "reason": "invalid_reason" }));
        assert!(result.is_err());
    }

    #[test]
    fn rejects_unknown_type_tag() {
        let result: Result<TokenResult, _> = serde_json::from_value(json!({ "type": "pending" }));
        assert!(result.is_err());
    }

    #[test]
    fn serializes_with_type_tag_first() {
        let success = TokenResult::Success(TokenSuccess {
            access: "a".into(),
            refresh: "r".into(),
            expires: 123,
            id_token: None,
            multi_account: None,
        });
        assert_eq!(
            serde_json::to_string(&success).unwrap(),
            r#"{"type":"success","access":"a","refresh":"r","expires":123}"#
        );
        let failure = TokenResult::Failed(TokenFailure::default());
        assert_eq!(
            serde_json::to_string(&failure).unwrap(),
            r#"{"type":"failed"}"#
        );
    }

    #[test]
    fn oauth_accepts_valid_response() {
        let response: OAuthTokenResponse =
            serde_json::from_value(json!({ "access_token": "at_123", "expires_in": 3600 }))
                .expect("parses");
        assert_eq!(response.access_token, "at_123");
        assert_eq!(response.expires_in, 3600);
    }

    #[test]
    fn oauth_accepts_response_with_all_fields() {
        let response: OAuthTokenResponse = serde_json::from_value(json!({
            "access_token": "at_123",
            "refresh_token": "rt_456",
            "expires_in": 3600,
            "id_token": "id_789",
            "token_type": "Bearer",
            "scope": "openid profile",
        }))
        .expect("parses");
        assert_eq!(response.refresh_token.as_deref(), Some("rt_456"));
        assert_eq!(response.token_type.as_deref(), Some("Bearer"));
        assert_eq!(response.scope.as_deref(), Some("openid profile"));
    }

    #[test]
    fn oauth_rejects_missing_access_token() {
        let result: Result<OAuthTokenResponse, _> =
            serde_json::from_value(json!({ "expires_in": 3600 }));
        assert!(result.is_err());
    }

    #[test]
    fn oauth_rejects_missing_expires_in() {
        let result: Result<OAuthTokenResponse, _> =
            serde_json::from_value(json!({ "access_token": "at" }));
        assert!(result.is_err());
    }

    #[test]
    fn oauth_i1_rejects_zero_or_negative_expires_in() {
        for bad in [0, -1, -3600] {
            let result: Result<OAuthTokenResponse, _> =
                serde_json::from_value(json!({ "access_token": "at_123", "expires_in": bad }));
            assert!(result.is_err(), "expires_in {bad} should be rejected");
        }
    }

    #[test]
    fn oauth_i1_rejects_non_integer_expires_in() {
        let result: Result<OAuthTokenResponse, _> =
            serde_json::from_value(json!({ "access_token": "at_123", "expires_in": 12.5 }));
        assert!(result.is_err());
    }

    #[test]
    fn zod_optional_is_not_nullable_explicit_null_fails() {
        // OAuth servers occasionally send explicit nulls; zod `.optional()`
        // rejects them, routing the exchange to the failure path.
        for key in ["refresh_token", "id_token", "token_type", "scope"] {
            let result: Result<OAuthTokenResponse, _> = serde_json::from_value(json!({
                "access_token": "at_123",
                "expires_in": 3600,
                key: null,
            }));
            assert!(result.is_err(), "{key}: null should fail the parse");
        }
        let mut success = valid_success();
        success["idToken"] = json!(null);
        assert!(serde_json::from_value::<TokenResult>(success).is_err());
        let failure: Result<TokenResult, _> =
            serde_json::from_value(json!({ "type": "failed", "reason": null }));
        assert!(failure.is_err());
        let status_null: Result<TokenResult, _> =
            serde_json::from_value(json!({ "type": "failed", "statusCode": null }));
        assert!(status_null.is_err());
    }

    #[test]
    fn token_success_rejects_non_positive_or_fractional_expires() {
        for bad in [json!(0), json!(-1), json!(12.5)] {
            let mut value = valid_success();
            value["expires"] = bad.clone();
            assert!(
                serde_json::from_value::<TokenResult>(value).is_err(),
                "expires {bad} should be rejected"
            );
        }
    }
}
