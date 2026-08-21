//! Port of `lib/auth/auth.ts` — OAuth core: constants, PKCE flow builder,
//! code→token exchange, refresh, log redaction (spec 07 §1).
//!
//! - `CLIENT_ID` / `REDIRECT_URI` (port 1455) are provider-registered and
//!   IMMOVABLE (spec 07 gotcha 8).
//! - PKCE S256 is self-implemented (sha2 + base64 URL_SAFE_NO_PAD) — no
//!   external OAuth dependency (spec 07 gotcha 23).
//! - The authorization-code exchange REQUIRES a `refresh_token` in the
//!   response; refresh keeps the input token when the response omits one
//!   (spec 07 gotcha 3).
//! - Never log token material: bodies pass through
//!   [`sanitize_oauth_response_body_for_log`], URLs through
//!   [`redact_oauth_url_for_log`], schema-failure logs carry only shape
//!   metadata (spec 07 gotcha 5).

use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use cma_core::logger::log_error;
use cma_core::schemas::parse::safe_parse_oauth_token_response;
use cma_core::schemas::token::{TokenFailure, TokenFailureReason, TokenResult, TokenSuccess};
use cma_core::types::{AuthorizationFlow, PKCEPair, ParsedAuthInput};
use cma_core::utils::now_ms;

// Re-exports (ARCHITECTURE §4 note 2: `decodeJWT`/token-utils live in core;
// `cma-auth` re-exports them so auth-cluster callers keep the TS import shape).
pub use cma_core::jwt::{decode_jwt, decode_jwt_value};
pub use cma_core::token_utils;

// ---------------------------------------------------------------------------
// OAuth constants (from openai/codex) — exact values, spec 07 §1.
// ---------------------------------------------------------------------------

pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
pub const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
pub const SCOPE: &str = "openid profile email offline_access";

/// Parsed representation of [`REDIRECT_URI`]. Single source of truth for the
/// OAuth callback origin so the local server bind, user-facing copy, and the
/// success page never drift from each other (TS `AUTH_REDIRECT`, frozen).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthRedirect {
    pub host: &'static str,
    pub port: u16,
    pub path: &'static str,
    pub origin: &'static str,
    pub url: &'static str,
}

/// The provider registers the exact string in [`REDIRECT_URI`]; these fields
/// are derived from it (a unit test asserts they cannot drift).
pub const AUTH_REDIRECT: AuthRedirect = AuthRedirect {
    host: "localhost",
    port: 1455,
    path: "/auth/callback",
    origin: "http://localhost:1455",
    url: REDIRECT_URI,
};

const OAUTH_SENSITIVE_QUERY_PARAMS: [&str; 4] = ["state", "code", "code_challenge", "code_verifier"];

const OAUTH_SENSITIVE_BODY_KEYS: [&str; 10] = [
    "refresh_token",
    "refreshToken",
    "access_token",
    "accessToken",
    "id_token",
    "idToken",
    "codeVerifier",
    "token",
    "code",
    "code_verifier",
];

const REDACTED: &str = "***REDACTED***";

// ---------------------------------------------------------------------------
// Log scrubbing (hand-rolled ports of the TS regexes — the `regex` crate is
// not a dependency of this crate; the matchers below reproduce the exact
// pattern semantics, including JS `\b` = [A-Za-z0-9_] word boundaries).
// ---------------------------------------------------------------------------

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn match_literal_ci(chars: &[char], start: usize, literal: &str) -> Option<usize> {
    let mut j = start;
    for lc in literal.chars() {
        let c = *chars.get(j)?;
        if c.to_ascii_lowercase() != lc {
            return None;
        }
        j += 1;
    }
    Some(j)
}

/// `(\b(?:refresh|access|id)[_-]?token\s*[:=]\s*)([^\s,;"'}]{8,})` (flags gi):
/// returns `(prefix_end, value_end)` when the pattern matches at `start`.
fn match_token_assignment(chars: &[char], start: usize) -> Option<(usize, usize)> {
    if start > 0 && is_word_char(chars[start - 1]) {
        return None; // no word boundary before the keyword
    }
    // (?:refresh|access|id) — alternatives in order, case-insensitive.
    let mut j = ["refresh", "access", "id"]
        .iter()
        .find_map(|kw| match_literal_ci(chars, start, kw))?;
    // [_-]?
    if matches!(chars.get(j), Some('_') | Some('-')) {
        j += 1;
    }
    // token
    j = match_literal_ci(chars, j, "token")?;
    // \s*
    while chars.get(j).is_some_and(|c| c.is_whitespace()) {
        j += 1;
    }
    // [:=]
    if !matches!(chars.get(j), Some(':') | Some('=')) {
        return None;
    }
    j += 1;
    // \s*
    while chars.get(j).is_some_and(|c| c.is_whitespace()) {
        j += 1;
    }
    let prefix_end = j;
    // [^\s,;"'}]{8,}
    let mut k = j;
    while chars
        .get(k)
        .is_some_and(|c| !c.is_whitespace() && !matches!(c, ',' | ';' | '"' | '\'' | '}'))
    {
        k += 1;
    }
    if k - prefix_end >= 8 {
        Some((prefix_end, k))
    } else {
        None
    }
}

/// `\b(?:RT|AT)_ch_[A-Za-z0-9_-]{20,}\b` (flag g, case-sensitive): returns
/// the end index of the match when it matches at `start`.
fn match_opaque_token(chars: &[char], start: usize) -> Option<usize> {
    if start > 0 && is_word_char(chars[start - 1]) {
        return None;
    }
    let lead: String = chars.get(start..start + 6)?.iter().collect();
    if lead != "RT_ch_" && lead != "AT_ch_" {
        return None;
    }
    let run_start = start + 6;
    let mut k = run_start;
    while chars
        .get(k)
        .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
    {
        k += 1;
    }
    // Trailing `\b`: the char after the maximal run is never a word char, so
    // the last matched char must BE one — backtrack over trailing hyphens.
    let mut end = k;
    while end > run_start && chars[end - 1] == '-' {
        end -= 1;
    }
    if end - run_start >= 20 { Some(end) } else { None }
}

fn scrub_token_like_substrings(value: &str) -> String {
    // Pass 1: keyed assignments (refresh_token: xxx / access-token=xxx …).
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut i = 0usize;
    while i < chars.len() {
        if let Some((prefix_end, value_end)) = match_token_assignment(&chars, i) {
            out.extend(&chars[i..prefix_end]);
            out.push_str(REDACTED);
            i = value_end;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    // Pass 2: bare opaque ChatGPT tokens (RT_ch_… / AT_ch_…).
    let chars: Vec<char> = out.chars().collect();
    let mut scrubbed = String::with_capacity(out.len());
    let mut i = 0usize;
    while i < chars.len() {
        if let Some(end) = match_opaque_token(&chars, i) {
            scrubbed.push_str(REDACTED);
            i = end;
        } else {
            scrubbed.push(chars[i]);
            i += 1;
        }
    }
    scrubbed
}

fn redact_sensitive_fields(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(redact_sensitive_fields).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if OAUTH_SENSITIVE_BODY_KEYS.contains(&k.as_str()) {
                    out.insert(k.clone(), Value::String(REDACTED.to_string()));
                } else {
                    out.insert(k.clone(), redact_sensitive_fields(v));
                }
            }
            Value::Object(out)
        }
        Value::String(s) => Value::String(scrub_token_like_substrings(s)),
        other => other.clone(),
    }
}

fn matches_at(chars: &[char], start: usize, needle: &[char]) -> bool {
    chars
        .get(start..start + needle.len())
        .is_some_and(|window| window == needle)
}

/// `("key"\s*:\s*)"[^"]*"` (flag g) → `$1"***REDACTED***"`.
fn scrub_json_style(input: &str, key: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let needle: Vec<char> = format!("\"{key}\"").chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '"' && matches_at(&chars, i, &needle) {
            let mut k = i + needle.len();
            while chars.get(k).is_some_and(|c| c.is_whitespace()) {
                k += 1;
            }
            if matches!(chars.get(k), Some(':')) {
                k += 1;
                while chars.get(k).is_some_and(|c| c.is_whitespace()) {
                    k += 1;
                }
                if matches!(chars.get(k), Some('"')) {
                    // consume [^"]* then the closing quote
                    let mut v = k + 1;
                    while chars.get(v).is_some_and(|c| *c != '"') {
                        v += 1;
                    }
                    if v < chars.len() {
                        out.extend(&chars[i..k]); // `$1` = "key"\s*:\s*
                        out.push('"');
                        out.push_str(REDACTED);
                        out.push('"');
                        i = v + 1;
                        continue;
                    }
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// `(^|[?&\s])(key=)[^&\s]+` (flag g) → `$1$2***REDACTED***`.
fn scrub_url_style(input: &str, key: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let needle: Vec<char> = format!("{key}=").chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    while i < chars.len() {
        let boundary_ok =
            i == 0 || matches!(chars[i - 1], '?' | '&') || chars[i - 1].is_whitespace();
        if boundary_ok && matches_at(&chars, i, &needle) {
            let value_start = i + needle.len();
            let mut k = value_start;
            while chars
                .get(k)
                .is_some_and(|c| *c != '&' && !c.is_whitespace())
            {
                k += 1;
            }
            if k > value_start {
                out.extend(&chars[i..value_start]);
                out.push_str(REDACTED);
                i = k;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Scrub opaque tokens from a raw OAuth token-endpoint response body before
/// interpolating it into a log message (TS `sanitizeOAuthResponseBodyForLog`).
///
/// ChatGPT refresh tokens are opaque high-entropy strings that do NOT match
/// the logger's generic TOKEN_PATTERNS, so without this they would be written
/// verbatim to disk log files (LIB-HIGH-001).
pub fn sanitize_oauth_response_body_for_log(raw_body: &str) -> String {
    if raw_body.is_empty() {
        return raw_body.to_string();
    }
    let trimmed = raw_body.trim();
    if trimmed.is_empty() {
        return raw_body.to_string();
    }

    // Malformed JSON falls through to the regex scrub below.
    if (trimmed.starts_with('{') || trimmed.starts_with('['))
        && let Ok(parsed) = serde_json::from_str::<Value>(trimmed)
    {
        let redacted = redact_sensitive_fields(&parsed);
        // Compact JSON.stringify of the redacted structure.
        return serde_json::to_string(&redacted).unwrap_or_else(|_| raw_body.to_string());
    }

    let mut scrubbed = raw_body.to_string();
    for key in OAUTH_SENSITIVE_BODY_KEYS {
        scrubbed = scrub_json_style(&scrubbed, key);
        scrubbed = scrub_url_style(&scrubbed, key);
    }
    scrubbed
}

/// Redacts sensitive OAuth query parameters (`state`, `code`,
/// `code_challenge`, `code_verifier`) for safe logging. Returns the original
/// string when parsing fails (TS `redactOAuthUrlForLog`).
pub fn redact_oauth_url_for_log(raw_url: &str) -> String {
    let Ok(mut parsed) = url::Url::parse(raw_url) else {
        return raw_url.to_string();
    };
    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let any_sensitive = pairs
        .iter()
        .any(|(k, _)| OAUTH_SENSITIVE_QUERY_PARAMS.contains(&k.as_str()));
    if !any_sensitive {
        // No mutation → the query is serialized untouched (URLSearchParams
        // only re-serializes once `set` is called — same here).
        return parsed.to_string();
    }
    // `searchParams.set` semantics: first occurrence replaced in place, later
    // duplicates of the same key removed; full query re-serialized.
    let mut replaced: Vec<String> = Vec::new();
    let mut rebuilt: Vec<(String, String)> = Vec::new();
    for (k, v) in pairs {
        if OAUTH_SENSITIVE_QUERY_PARAMS.contains(&k.as_str()) {
            if replaced.contains(&k) {
                continue;
            }
            replaced.push(k.clone());
            rebuilt.push((k, "<redacted>".to_string()));
        } else {
            rebuilt.push((k, v));
        }
    }
    parsed.query_pairs_mut().clear().extend_pairs(rebuilt);
    parsed.to_string()
}

// ---------------------------------------------------------------------------
// State / PKCE / input parsing
// ---------------------------------------------------------------------------

/// Generate a random state value for the OAuth flow: 16 CSPRNG bytes as 32
/// lowercase hex chars (TS `createState`).
pub fn create_state() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    let mut out = String::with_capacity(32);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Generate a PKCE S256 pair: verifier = base64url(32 CSPRNG bytes) (43
/// chars, RFC 7636), challenge = base64url(SHA-256(verifier)).
pub fn generate_pkce() -> PKCEPair {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    PKCEPair {
        challenge,
        verifier,
    }
}

/// Parse authorization code and state from user input: a full URL, a
/// `code#state` pair, a query string, or a raw code (TS
/// `parseAuthorizationInput`).
pub fn parse_authorization_input(input: &str) -> ParsedAuthInput {
    let value = input.trim();
    if value.is_empty() {
        return ParsedAuthInput::default();
    }

    if let Ok(parsed) = url::Url::parse(value) {
        let mut code = parsed
            .query_pairs()
            .find(|(k, _)| k == "code")
            .map(|(_, v)| v.into_owned());
        let mut state = parsed
            .query_pairs()
            .find(|(k, _)| k == "state")
            .map(|(_, v)| v.into_owned());

        // Fallback: check the fragment if not found in searchParams
        // (`#code=…` format).
        if let Some(hash) = parsed.fragment()
            && !hash.is_empty()
            && (code.is_none() || state.is_none())
        {
            let hash_pairs: Vec<(String, String)> = url::form_urlencoded::parse(hash.as_bytes())
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            if code.is_none() {
                code = hash_pairs
                    .iter()
                    .find(|(k, _)| k == "code")
                    .map(|(_, v)| v.clone());
            }
            if state.is_none() {
                state = hash_pairs
                    .iter()
                    .find(|(k, _)| k == "state")
                    .map(|(_, v)| v.clone());
            }
        }

        if code.is_some() || state.is_some() {
            return ParsedAuthInput { code, state };
        }
        // Invalid/hollow URL — fall through to the other parsing methods.
    }

    if value.contains('#') {
        // TS `value.split("#", 2)` — first two segments.
        let mut parts = value.splitn(3, '#');
        let code = parts.next().unwrap_or_default().to_string();
        let state = parts.next().unwrap_or_default().to_string();
        return ParsedAuthInput {
            code: Some(code),
            state: Some(state),
        };
    }
    if value.contains("code=") {
        let pairs: Vec<(String, String)> = url::form_urlencoded::parse(value.as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        return ParsedAuthInput {
            code: pairs
                .iter()
                .find(|(k, _)| k == "code")
                .map(|(_, v)| v.clone()),
            state: pairs
                .iter()
                .find(|(k, _)| k == "state")
                .map(|(_, v)| v.clone()),
        };
    }
    ParsedAuthInput {
        code: Some(value.to_string()),
        state: None,
    }
}

// ---------------------------------------------------------------------------
// Token endpoint calls
// ---------------------------------------------------------------------------

static HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

fn failed(
    reason: TokenFailureReason,
    status_code: Option<i64>,
    message: Option<String>,
) -> TokenResult {
    TokenResult::Failed(TokenFailure {
        reason: Some(reason),
        status_code,
        message,
    })
}

/// Shape-only log metadata for schema failures — key/item counts, never keys
/// or values (TS `getOAuthResponseLogMetadata`).
fn oauth_response_log_metadata(raw: &Value) -> Value {
    match raw {
        Value::Array(items) => json!({ "responseType": "array", "itemCount": items.len() }),
        Value::Object(map) => json!({ "responseType": "object", "keyCount": map.len() }),
        // JS `typeof null === "object"`.
        Value::Null => json!({ "responseType": "object" }),
        Value::Bool(_) => json!({ "responseType": "boolean" }),
        Value::Number(_) => json!({ "responseType": "number" }),
        Value::String(_) => json!({ "responseType": "string" }),
    }
}

/// Exchange an authorization code for tokens against the production
/// [`TOKEN_URL`]. `redirect_uri` defaults to [`REDIRECT_URI`] when `None`.
pub async fn exchange_authorization_code(
    code: &str,
    verifier: &str,
    redirect_uri: Option<&str>,
) -> TokenResult {
    exchange_authorization_code_at(TOKEN_URL, code, verifier, redirect_uri).await
}

/// [`exchange_authorization_code`] against an explicit token endpoint (test
/// seam — the TS tests stub global `fetch`; Rust points at a mock server).
pub async fn exchange_authorization_code_at(
    token_url: &str,
    code: &str,
    verifier: &str,
    redirect_uri: Option<&str>,
) -> TokenResult {
    let redirect_uri = redirect_uri.unwrap_or(REDIRECT_URI);
    let form: [(&str, &str); 5] = [
        ("grant_type", "authorization_code"),
        ("client_id", CLIENT_ID),
        ("code", code),
        ("code_verifier", verifier),
        ("redirect_uri", redirect_uri),
    ];
    let response = match HTTP_CLIENT.post(token_url).form(&form).send().await {
        Ok(response) => response,
        // TS lets transport errors throw out of exchangeAuthorizationCode;
        // the Rust port folds them into a network_error failure so
        // `runDeviceAuthFlow`-style callers stay total.
        Err(error) => {
            return failed(
                TokenFailureReason::NetworkError,
                None,
                Some(error.to_string()),
            );
        }
    };
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let text = response.text().await.unwrap_or_default();
        let safe_text = sanitize_oauth_response_body_for_log(&text);
        log_error(&format!("code->token failed: {status} {safe_text}"), None);
        let message = if safe_text.is_empty() {
            None
        } else {
            Some(safe_text)
        };
        return failed(TokenFailureReason::HttpError, Some(status as i64), message);
    }
    let raw_json: Value = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            return failed(
                TokenFailureReason::NetworkError,
                None,
                Some(error.to_string()),
            );
        }
    };
    let Some(json) = safe_parse_oauth_token_response(&raw_json) else {
        log_error(
            "token response validation failed",
            Some(&oauth_response_log_metadata(&raw_json)),
        );
        return failed(
            TokenFailureReason::InvalidResponse,
            None,
            Some("Response failed schema validation".to_string()),
        );
    };
    let refresh_token = json.refresh_token.as_deref().unwrap_or("").trim();
    if refresh_token.is_empty() {
        log_error(
            "token response missing refresh token",
            Some(&oauth_response_log_metadata(&raw_json)),
        );
        return failed(
            TokenFailureReason::InvalidResponse,
            None,
            Some("Missing refresh token in authorization code exchange response".to_string()),
        );
    }
    TokenResult::Success(TokenSuccess {
        access: json.access_token,
        refresh: refresh_token.to_string(),
        expires: now_ms() + json.expires_in * 1000,
        id_token: json.id_token,
        multi_account: Some(true),
    })
}

/// Refresh an access token against the production [`TOKEN_URL`].
///
/// Refresh-token ROTATION: the next refresh token is the response value when
/// present, else the input token; both trimmed; empty → `missing_refresh`.
pub async fn refresh_access_token(refresh_token: &str) -> TokenResult {
    refresh_access_token_at(TOKEN_URL, refresh_token).await
}

/// [`refresh_access_token`] against an explicit token endpoint (test seam).
pub async fn refresh_access_token_at(token_url: &str, refresh_token: &str) -> TokenResult {
    let form: [(&str, &str); 3] = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", CLIENT_ID),
    ];
    let response = match HTTP_CLIENT.post(token_url).form(&form).send().await {
        Ok(response) => response,
        Err(error) => {
            // TS catch branch: abort → reason "unknown" without logging;
            // other errors → logged network_error. Rust has no AbortSignal
            // on this path, so every transport failure is a network_error.
            log_error(
                "Token refresh error",
                Some(&json!({ "message": error.to_string() })),
            );
            return failed(
                TokenFailureReason::NetworkError,
                None,
                Some(error.to_string()),
            );
        }
    };
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let text = response.text().await.unwrap_or_default();
        let safe_text = sanitize_oauth_response_body_for_log(&text);
        log_error(&format!("Token refresh failed: {status} {safe_text}"), None);
        let message = if safe_text.is_empty() {
            None
        } else {
            Some(safe_text)
        };
        return failed(TokenFailureReason::HttpError, Some(status as i64), message);
    }
    let raw_json: Value = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            log_error(
                "Token refresh error",
                Some(&json!({ "message": error.to_string() })),
            );
            return failed(
                TokenFailureReason::NetworkError,
                None,
                Some(error.to_string()),
            );
        }
    };
    let Some(json) = safe_parse_oauth_token_response(&raw_json) else {
        log_error(
            "Token refresh response validation failed",
            Some(&oauth_response_log_metadata(&raw_json)),
        );
        return failed(
            TokenFailureReason::InvalidResponse,
            None,
            Some("Response failed schema validation".to_string()),
        );
    };
    // Refresh-token rotation: response value wins, else the input token.
    let next_refresh_raw = json.refresh_token.as_deref().unwrap_or(refresh_token);
    let next_refresh = next_refresh_raw.trim();
    if next_refresh.is_empty() {
        log_error("Token refresh missing refresh token", None);
        return failed(
            TokenFailureReason::MissingRefresh,
            None,
            Some("No refresh token in response or input".to_string()),
        );
    }
    TokenResult::Success(TokenSuccess {
        access: json.access_token,
        refresh: next_refresh.to_string(),
        expires: now_ms() + json.expires_in * 1000,
        id_token: json.id_token,
        multi_account: Some(true),
    })
}

// ---------------------------------------------------------------------------
// Authorization flow builder
// ---------------------------------------------------------------------------

/// Options for [`create_authorization_flow`] (TS `AuthorizationFlowOptions`).
#[derive(Debug, Clone, Copy, Default)]
pub struct AuthorizationFlowOptions {
    /// Force a fresh login screen instead of using a cached browser session.
    /// Use when adding multiple accounts to ensure different credentials.
    pub force_new_login: bool,
}

/// Create the OAuth authorization flow: PKCE pair, state, and the authorize
/// URL with the exact parameter set/order of the TS implementation
/// (including `id_token_add_organizations` / `codex_cli_simplified_flow` /
/// `originator=codex_cli_rs`, and `prompt=login` only when forcing a new
/// login — spec 07 gotcha 23).
pub fn create_authorization_flow(options: AuthorizationFlowOptions) -> AuthorizationFlow {
    let pkce = generate_pkce();
    let state = create_state();

    let mut url = url::Url::parse(AUTHORIZE_URL).expect("AUTHORIZE_URL is a valid URL");
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("response_type", "code");
        qp.append_pair("client_id", CLIENT_ID);
        qp.append_pair("redirect_uri", REDIRECT_URI);
        qp.append_pair("scope", SCOPE);
        qp.append_pair("code_challenge", &pkce.challenge);
        qp.append_pair("code_challenge_method", "S256");
        qp.append_pair("state", &state);
        qp.append_pair("id_token_add_organizations", "true");
        qp.append_pair("codex_cli_simplified_flow", "true");
        qp.append_pair("originator", "codex_cli_rs");
        // Force a fresh login screen when adding multiple accounts. This
        // helps prevent the browser from auto-using an existing session.
        if options.force_new_login {
            qp.append_pair("prompt", "login");
        }
    }

    AuthorizationFlow {
        pkce,
        state,
        url: url.to_string(),
    }
}

// ===========================================================================
// Tests (ported from test/auth.test.ts)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const OPAQUE_REFRESH: &str = "RT_ch_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP0123456789";
    const OPAQUE_ACCESS: &str = "AT_ch_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

    fn is_lower_hex_32(s: &str) -> bool {
        s.len() == 32 && s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    }

    // ----- createState -----------------------------------------------------

    #[test]
    fn create_state_generates_32_char_hex() {
        let state = create_state();
        assert!(is_lower_hex_32(&state), "state {state:?} should be 32 hex chars");
    }

    #[test]
    fn create_state_generates_unique_states() {
        assert_ne!(create_state(), create_state());
    }

    // ----- parseAuthorizationInput -----------------------------------------

    fn parsed(code: Option<&str>, state: Option<&str>) -> ParsedAuthInput {
        ParsedAuthInput {
            code: code.map(String::from),
            state: state.map(String::from),
        }
    }

    #[test]
    fn parses_full_oauth_callback_url() {
        assert_eq!(
            parse_authorization_input("http://127.0.0.1:1455/auth/callback?code=abc123&state=xyz789"),
            parsed(Some("abc123"), Some("xyz789"))
        );
    }

    #[test]
    fn parses_localhost_callback_url() {
        assert_eq!(
            parse_authorization_input("http://localhost:1455/auth/callback?code=abc123&state=xyz789"),
            parsed(Some("abc123"), Some("xyz789"))
        );
    }

    #[test]
    fn parses_code_hash_state_format() {
        assert_eq!(
            parse_authorization_input("abc123#xyz789"),
            parsed(Some("abc123"), Some("xyz789"))
        );
    }

    #[test]
    fn parses_query_string_format() {
        assert_eq!(
            parse_authorization_input("code=abc123&state=xyz789"),
            parsed(Some("abc123"), Some("xyz789"))
        );
    }

    #[test]
    fn parses_query_string_with_code_only() {
        assert_eq!(
            parse_authorization_input("code=abc123"),
            parsed(Some("abc123"), None)
        );
    }

    #[test]
    fn parses_url_with_fragment_parameters() {
        assert_eq!(
            parse_authorization_input("http://127.0.0.1:1455/auth/callback#code=abc123&state=xyz789"),
            parsed(Some("abc123"), Some("xyz789"))
        );
    }

    #[test]
    fn prefers_query_params_over_hash_params() {
        assert_eq!(
            parse_authorization_input(
                "http://127.0.0.1:1455/auth/callback?code=querycode&state=querystate#code=hashcode&state=hashstate"
            ),
            parsed(Some("querycode"), Some("querystate"))
        );
    }

    #[test]
    fn falls_back_to_hash_for_missing_state_in_query() {
        assert_eq!(
            parse_authorization_input("http://127.0.0.1:1455/auth/callback?code=querycode#state=hashstate"),
            parsed(Some("querycode"), Some("hashstate"))
        );
    }

    #[test]
    fn falls_back_to_hash_for_missing_code_in_query() {
        assert_eq!(
            parse_authorization_input("http://127.0.0.1:1455/auth/callback?state=querystate#code=hashcode"),
            parsed(Some("hashcode"), Some("querystate"))
        );
    }

    #[test]
    fn handles_url_with_hash_code_only() {
        assert_eq!(
            parse_authorization_input("http://127.0.0.1:1455/auth/callback#code=abc123"),
            parsed(Some("abc123"), None)
        );
    }

    #[test]
    fn returns_state_only_when_only_state_in_hash() {
        assert_eq!(
            parse_authorization_input("http://127.0.0.1:1455/auth/callback#state=hashstate"),
            parsed(None, Some("hashstate"))
        );
    }

    #[test]
    fn parses_code_only() {
        assert_eq!(parse_authorization_input("abc123"), parsed(Some("abc123"), None));
    }

    #[test]
    fn returns_empty_for_empty_input() {
        assert_eq!(parse_authorization_input(""), ParsedAuthInput::default());
    }

    #[test]
    fn handles_whitespace() {
        assert_eq!(parse_authorization_input("  "), ParsedAuthInput::default());
    }

    #[test]
    fn falls_through_to_hash_split_when_url_hash_has_no_params() {
        // URL parses successfully but the hash has no code=/state= params →
        // falls through to the `#` split.
        assert_eq!(
            parse_authorization_input("http://127.0.0.1:1455/auth/callback#invalid"),
            parsed(Some("http://127.0.0.1:1455/auth/callback"), Some("invalid"))
        );
    }

    // ----- createAuthorizationFlow -----------------------------------------

    #[test]
    fn creates_authorization_flow_with_pkce() {
        let flow = create_authorization_flow(AuthorizationFlowOptions::default());
        assert!(!flow.pkce.challenge.is_empty());
        assert!(!flow.pkce.verifier.is_empty());
        assert_eq!(flow.pkce.verifier.len(), 43, "RFC 7636 base64url of 32 bytes");
        assert!(is_lower_hex_32(&flow.state));
        // S256: challenge = base64url(sha256(verifier))
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(flow.pkce.verifier.as_bytes()));
        assert_eq!(flow.pkce.challenge, expected);
    }

    #[test]
    fn generates_url_with_correct_parameters() {
        let flow = create_authorization_flow(AuthorizationFlowOptions::default());
        let url = url::Url::parse(&flow.url).expect("flow url parses");
        assert_eq!(
            format!(
                "{}://{}{}",
                url.scheme(),
                url.host_str().unwrap(),
                url.path()
            ),
            AUTHORIZE_URL
        );
        let get = |key: &str| {
            url.query_pairs()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.into_owned())
        };
        assert_eq!(get("response_type").as_deref(), Some("code"));
        assert_eq!(get("client_id").as_deref(), Some(CLIENT_ID));
        assert_eq!(get("redirect_uri").as_deref(), Some(REDIRECT_URI));
        assert_eq!(get("scope").as_deref(), Some(SCOPE));
        assert_eq!(get("code_challenge_method").as_deref(), Some("S256"));
        assert_eq!(get("code_challenge").as_deref(), Some(flow.pkce.challenge.as_str()));
        assert_eq!(get("state").as_deref(), Some(flow.state.as_str()));
        assert_eq!(get("id_token_add_organizations").as_deref(), Some("true"));
        assert_eq!(get("codex_cli_simplified_flow").as_deref(), Some("true"));
        assert_eq!(get("originator").as_deref(), Some("codex_cli_rs"));
        assert_eq!(get("prompt"), None);
    }

    #[test]
    fn includes_prompt_login_when_force_new_login() {
        let flow = create_authorization_flow(AuthorizationFlowOptions {
            force_new_login: true,
        });
        let url = url::Url::parse(&flow.url).unwrap();
        let prompt = url
            .query_pairs()
            .find(|(k, _)| k == "prompt")
            .map(|(_, v)| v.into_owned());
        assert_eq!(prompt.as_deref(), Some("login"));
    }

    #[test]
    fn generates_unique_flows() {
        let flow1 = create_authorization_flow(AuthorizationFlowOptions::default());
        let flow2 = create_authorization_flow(AuthorizationFlowOptions::default());
        assert_ne!(flow1.state, flow2.state);
        assert_ne!(flow1.pkce.verifier, flow2.pkce.verifier);
        assert_ne!(flow1.url, flow2.url);
    }

    // ----- AUTH_REDIRECT ---------------------------------------------------

    #[test]
    fn auth_redirect_derives_from_redirect_uri_without_drift() {
        let parsed = url::Url::parse(REDIRECT_URI).unwrap();
        assert_eq!(AUTH_REDIRECT.host, parsed.host_str().unwrap());
        assert_eq!(AUTH_REDIRECT.path, parsed.path());
        assert_eq!(AUTH_REDIRECT.url, REDIRECT_URI);
        assert_eq!(AUTH_REDIRECT.port, parsed.port().unwrap_or(1455));
        assert_eq!(
            AUTH_REDIRECT.origin,
            format!("{}://{}", parsed.scheme(), &parsed[url::Position::BeforeHost..url::Position::AfterPort])
        );
    }

    #[test]
    fn locks_callback_port_at_1455() {
        // The OpenAI app registration pins this exact callback. If anyone
        // changes REDIRECT_URI without updating the registration, login
        // breaks; this assertion fails loudly before that ships.
        assert_eq!(AUTH_REDIRECT.port, 1455);
        assert_eq!(AUTH_REDIRECT.path, "/auth/callback");
    }

    // ----- redactOAuthUrlForLog --------------------------------------------

    #[test]
    fn redacts_sensitive_oauth_params_in_urls() {
        let raw = "https://auth.openai.com/oauth/authorize?state=abc123&code=xyz&code_challenge=foo&response_type=code";
        let redacted = redact_oauth_url_for_log(raw);
        assert!(!redacted.contains("abc123"));
        assert!(!redacted.contains("xyz"));
        assert!(!redacted.contains("foo"));
        assert!(redacted.contains("state=%3Credacted%3E"));
        assert!(redacted.contains("code=%3Credacted%3E"));
        assert!(redacted.contains("code_challenge=%3Credacted%3E"));
        assert!(redacted.contains("response_type=code"));
    }

    #[test]
    fn returns_original_input_when_url_parsing_fails() {
        assert_eq!(redact_oauth_url_for_log("not-a-url"), "not-a-url");
    }

    // ----- exchangeAuthorizationCode (wiremock) ----------------------------

    async fn token_server(body: Value, status: u16) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(status).set_body_json(body))
            .mount(&server)
            .await;
        server
    }

    fn token_url(server: &MockServer) -> String {
        format!("{}/oauth/token", server.uri())
    }

    async fn last_form_body(server: &MockServer) -> Vec<(String, String)> {
        let requests = server.received_requests().await.unwrap();
        let body = requests.last().expect("at least one request").body.clone();
        url::form_urlencoded::parse(&body)
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    }

    #[tokio::test]
    async fn exchange_returns_success_with_tokens() {
        let server = token_server(
            json!({
                "access_token": "access-123",
                "refresh_token": "refresh-456",
                "expires_in": 3600,
                "id_token": "id-token-789",
            }),
            200,
        )
        .await;
        let before = now_ms();
        let result =
            exchange_authorization_code_at(&token_url(&server), "auth-code", "verifier-123", None)
                .await;
        let after = now_ms();
        let success = result.as_success().expect("success");
        assert_eq!(success.access, "access-123");
        assert_eq!(success.refresh, "refresh-456");
        assert_eq!(success.id_token.as_deref(), Some("id-token-789"));
        assert_eq!(success.multi_account, Some(true));
        assert!(success.expires >= before + 3_600_000 && success.expires <= after + 3_600_000);

        // Verify the form body (grant_type / client_id / code / verifier /
        // default redirect_uri) exactly.
        let form = last_form_body(&server).await;
        assert_eq!(
            form,
            vec![
                ("grant_type".to_string(), "authorization_code".to_string()),
                ("client_id".to_string(), CLIENT_ID.to_string()),
                ("code".to_string(), "auth-code".to_string()),
                ("code_verifier".to_string(), "verifier-123".to_string()),
                ("redirect_uri".to_string(), REDIRECT_URI.to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn exchange_fails_when_refresh_token_missing() {
        let server = token_server(json!({ "access_token": "access-123", "expires_in": 3600 }), 200).await;
        let result =
            exchange_authorization_code_at(&token_url(&server), "auth-code", "verifier-123", None)
                .await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::InvalidResponse));
        assert!(failure.message.as_deref().unwrap().contains("Missing refresh token"));
    }

    #[tokio::test]
    async fn exchange_fails_when_refresh_token_whitespace_only() {
        let server = token_server(
            json!({ "access_token": "access-123", "refresh_token": "   ", "expires_in": 3600 }),
            200,
        )
        .await;
        let result =
            exchange_authorization_code_at(&token_url(&server), "auth-code", "verifier-123", None)
                .await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::InvalidResponse));
        assert!(failure.message.as_deref().unwrap().contains("Missing refresh token"));
    }

    #[tokio::test]
    async fn exchange_fails_for_http_error_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(400).set_body_string("Bad Request"))
            .mount(&server)
            .await;
        let result =
            exchange_authorization_code_at(&token_url(&server), "bad-code", "verifier", None).await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::HttpError));
        assert_eq!(failure.status_code, Some(400));
        assert_eq!(failure.message.as_deref(), Some("Bad Request"));
    }

    #[tokio::test]
    async fn exchange_fails_for_invalid_response_schema() {
        let server = token_server(json!({ "wrong": "schema" }), 200).await;
        let result =
            exchange_authorization_code_at(&token_url(&server), "code", "verifier", None).await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::InvalidResponse));
        assert_eq!(
            failure.message.as_deref(),
            Some("Response failed schema validation")
        );
    }

    #[tokio::test]
    async fn exchange_uses_custom_redirect_uri() {
        let server = token_server(json!({ "access_token": "access", "expires_in": 3600 }), 200).await;
        let _ = exchange_authorization_code_at(
            &token_url(&server),
            "code",
            "verifier",
            Some("http://custom:8080/callback"),
        )
        .await;
        let form = last_form_body(&server).await;
        let redirect = form
            .iter()
            .find(|(k, _)| k == "redirect_uri")
            .map(|(_, v)| v.clone());
        assert_eq!(redirect.as_deref(), Some("http://custom:8080/callback"));
    }

    // ----- refreshAccessToken (wiremock) -----------------------------------

    #[tokio::test]
    async fn refresh_keeps_existing_refresh_token_when_missing_in_response() {
        let server = token_server(json!({ "access_token": "new-access", "expires_in": 60 }), 200).await;
        let before = now_ms();
        let result = refresh_access_token_at(&token_url(&server), "existing-refresh").await;
        let after = now_ms();
        let success = result.as_success().expect("success");
        assert_eq!(success.access, "new-access");
        assert_eq!(success.refresh, "existing-refresh");
        assert_eq!(success.id_token, None);
        assert_eq!(success.multi_account, Some(true));
        assert!(success.expires >= before + 60_000 && success.expires <= after + 60_000);

        let form = last_form_body(&server).await;
        assert_eq!(
            form,
            vec![
                ("grant_type".to_string(), "refresh_token".to_string()),
                ("refresh_token".to_string(), "existing-refresh".to_string()),
                ("client_id".to_string(), CLIENT_ID.to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn refresh_fails_for_http_400_invalid_grant() {
        let server = token_server(json!({ "error": "invalid_grant" }), 400).await;
        let result = refresh_access_token_at(&token_url(&server), "bad-token").await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::HttpError));
        assert_eq!(failure.status_code, Some(400));
    }

    #[tokio::test]
    async fn refresh_fails_for_invalid_response_schema() {
        let server = token_server(json!({ "wrong": "schema" }), 200).await;
        let result = refresh_access_token_at(&token_url(&server), "some-token").await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::InvalidResponse));
    }

    #[tokio::test]
    async fn refresh_fails_for_network_errors() {
        // Nothing listens on this endpoint → transport error.
        let result = refresh_access_token_at("http://127.0.0.1:1/oauth/token", "some-token").await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::NetworkError));
        assert!(failure.message.is_some());
    }

    #[tokio::test]
    async fn refresh_fails_when_response_refresh_token_whitespace_only() {
        let server = token_server(
            json!({ "access_token": "new-access", "refresh_token": "   ", "expires_in": 60 }),
            200,
        )
        .await;
        let result = refresh_access_token_at(&token_url(&server), "existing-refresh").await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::MissingRefresh));
        assert_eq!(
            failure.message.as_deref(),
            Some("No refresh token in response or input")
        );
    }

    #[tokio::test]
    async fn refresh_fails_when_input_whitespace_and_response_omits_refresh() {
        let server = token_server(json!({ "access_token": "new-access", "expires_in": 60 }), 200).await;
        let result = refresh_access_token_at(&token_url(&server), "   ").await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::MissingRefresh));
        assert_eq!(
            failure.message.as_deref(),
            Some("No refresh token in response or input")
        );
    }

    #[tokio::test]
    async fn refresh_fails_when_both_response_and_input_empty() {
        let server = token_server(json!({ "access_token": "new-access", "expires_in": 60 }), 200).await;
        let result = refresh_access_token_at(&token_url(&server), "").await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::MissingRefresh));
        assert_eq!(
            failure.message.as_deref(),
            Some("No refresh token in response or input")
        );
    }

    #[tokio::test]
    async fn refresh_http_error_with_empty_body_has_no_message() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let result = refresh_access_token_at(&token_url(&server), "some-token").await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::HttpError));
        assert_eq!(failure.status_code, Some(500));
        assert_eq!(failure.message, None);
    }

    #[tokio::test]
    async fn refresh_returns_success_with_new_refresh_token_from_response() {
        let server = token_server(
            json!({
                "access_token": "new-access",
                "refresh_token": "new-refresh",
                "expires_in": 60,
                "id_token": "new-id-token",
            }),
            200,
        )
        .await;
        let result = refresh_access_token_at(&token_url(&server), "old-refresh").await;
        let success = result.as_success().expect("success");
        assert_eq!(success.access, "new-access");
        assert_eq!(success.refresh, "new-refresh");
        assert_eq!(success.id_token.as_deref(), Some("new-id-token"));
        assert_eq!(success.multi_account, Some(true));
    }

    #[tokio::test]
    async fn refresh_http_error_message_does_not_leak_tokens() {
        // LIB-HIGH-001: the failure message (and log line) must not carry the
        // opaque refresh token from the error body.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "error": "invalid_grant",
                "error_description": "refresh_token expired",
                "refresh_token": OPAQUE_REFRESH,
            })))
            .mount(&server)
            .await;
        let result = refresh_access_token_at(&token_url(&server), "input-token").await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.status_code, Some(400));
        let message = failure.message.as_deref().expect("message");
        assert!(!message.contains(OPAQUE_REFRESH));
        assert!(message.contains("invalid_grant"));
    }

    // ----- sanitizeOAuthResponseBodyForLog (LIB-HIGH-001 regression) -------

    #[test]
    fn masks_refresh_and_access_token_in_json_error_body() {
        let body = json!({
            "error": "invalid_grant",
            "error_description": "bad refresh",
            "refresh_token": OPAQUE_REFRESH,
            "access_token": OPAQUE_ACCESS,
            "id_token": "some.id.token",
        })
        .to_string();
        let out = sanitize_oauth_response_body_for_log(&body);
        assert!(!out.contains(OPAQUE_REFRESH));
        assert!(!out.contains(OPAQUE_ACCESS));
        assert!(out.contains(REDACTED));
        assert!(out.contains("invalid_grant"));
    }

    #[test]
    fn masks_nested_sensitive_fields_in_json_body() {
        let body = json!({
            "error": "invalid_grant",
            "debug": { "refresh_token": OPAQUE_REFRESH, "reason": "x" },
        })
        .to_string();
        let out = sanitize_oauth_response_body_for_log(&body);
        assert!(!out.contains(OPAQUE_REFRESH));
        assert!(out.contains("invalid_grant"));
        assert!(out.contains("x"));
    }

    #[test]
    fn masks_urlencoded_refresh_token_value_form() {
        let body = format!("error=invalid_grant&refresh_token={OPAQUE_REFRESH}&other=safe");
        let out = sanitize_oauth_response_body_for_log(&body);
        assert!(!out.contains(OPAQUE_REFRESH));
        assert!(out.contains("refresh_token=***REDACTED***"));
        assert!(out.contains("other=safe"));
    }

    #[test]
    fn does_not_over_redact_longer_parameter_names_ending_in_code() {
        let body =
            format!("error=invalid_grant&device_code=device-safe&refresh_token={OPAQUE_REFRESH}&other=safe");
        let out = sanitize_oauth_response_body_for_log(&body);
        assert!(out.contains("device_code=device-safe"));
        assert!(out.contains("refresh_token=***REDACTED***"));
        assert!(out.contains("other=safe"));
    }

    #[test]
    fn masks_refresh_token_in_malformed_json_via_fallback() {
        let body = format!("{{\"error\":\"invalid_grant\",\"refresh_token\":\"{OPAQUE_REFRESH}\",");
        let out = sanitize_oauth_response_body_for_log(&body);
        assert!(!out.contains(OPAQUE_REFRESH));
        assert!(out.contains("\"refresh_token\":\"***REDACTED***\""));
    }

    #[test]
    fn returns_non_token_plain_text_unchanged() {
        assert_eq!(sanitize_oauth_response_body_for_log("Bad Request"), "Bad Request");
        assert_eq!(sanitize_oauth_response_body_for_log(""), "");
    }

    #[test]
    fn preserves_structure_and_non_sensitive_json_fields() {
        let body = json!({
            "error": "invalid_grant",
            "status": 400,
            "refresh_token": OPAQUE_REFRESH,
        })
        .to_string();
        let out = sanitize_oauth_response_body_for_log(&body);
        let parsed: Value = serde_json::from_str(&out).expect("valid JSON");
        assert_eq!(parsed["error"], json!("invalid_grant"));
        assert_eq!(parsed["status"], json!(400));
        assert_eq!(parsed["refresh_token"], json!(REDACTED));
    }

    #[test]
    fn masks_camel_case_variants() {
        let body = json!({ "refreshToken": OPAQUE_REFRESH, "accessToken": OPAQUE_ACCESS }).to_string();
        let out = sanitize_oauth_response_body_for_log(&body);
        assert!(!out.contains(OPAQUE_REFRESH));
        assert!(!out.contains(OPAQUE_ACCESS));
    }

    #[test]
    fn masks_code_verifier_camel_case_variant() {
        let body = json!({ "codeVerifier": OPAQUE_REFRESH, "status": 400 }).to_string();
        let out = sanitize_oauth_response_body_for_log(&body);
        assert!(!out.contains(OPAQUE_REFRESH));
        assert!(out.contains(REDACTED));
        assert!(out.contains("400"));
    }

    #[test]
    fn scrubs_token_like_substrings_inside_parsed_json_string_values() {
        let body =
            json!({ "error_description": format!("refresh failed for token {OPAQUE_REFRESH}") })
                .to_string();
        let out = sanitize_oauth_response_body_for_log(&body);
        assert!(!out.contains(OPAQUE_REFRESH));
        assert!(out.contains(REDACTED));
    }

    #[test]
    fn scrubs_keyed_assignment_substrings() {
        // Regex 1 semantics: keep the `refresh_token: ` prefix, mask the value.
        let input = "failure: refresh_token: abcdefgh12345678 next";
        let out = scrub_token_like_substrings(input);
        assert_eq!(out, "failure: refresh_token: ***REDACTED*** next");
        // Values shorter than 8 chars are NOT masked.
        assert_eq!(
            scrub_token_like_substrings("refresh_token: short"),
            "refresh_token: short"
        );
    }
}
