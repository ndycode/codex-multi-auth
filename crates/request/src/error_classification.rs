//! Port of `lib/request/error-classification.ts` — upstream error
//! classification.
//!
//! Behavior source: spec 06 §7 + the TS source (authority). `fetch_helpers`
//! re-exports this module's public surface, mirroring the TS re-export
//! contract.
//!
//! CRITICAL (spec 06 gotcha 5): [`canonicalize_model_name`] strips ONLY the
//! `-(none|minimal|low|medium|high|xhigh)` suffixes. It deliberately does NOT
//! strip `-max`/`-ultra` — unlike the transformer's `VARIANT_SUFFIX_PATTERN`.

use std::sync::OnceLock;

use cma_core::schemas::plugin_config::FallbackChain;
use cma_core::utils::is_record;
use regex::Regex;
use serde_json::Value;

use crate::fetch_helpers::SyntheticResponse;

/// `@internal` in TS — exported for sibling request modules.
pub const CHATGPT_CODEX_UNSUPPORTED_MODEL_CODE: &str = "model_not_supported_with_chatgpt_account";

fn chatgpt_codex_unsupported_model_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)model is not supported when using codex with a chatgpt account").unwrap()
    })
}

fn normalized_unsupported_model_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)the model ['"]([^'"]+)['"] is not currently available for this chatgpt account"#)
            .unwrap()
    })
}

fn model_access_denied_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)the model [`'"]([^`'"]+)[`'"] does not exist or you do not have access to it"#)
            .unwrap()
    })
}

fn direct_unsupported_model_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)['"]([^'"]+)['"]\s+model is not supported when using codex with a chatgpt account"#,
        )
        .unwrap()
    })
}

fn entitlement_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)usage_not_included|not.included.in.your.plan|subscription.does.not.include")
            .unwrap()
    })
}

/// `DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN` — exact table & order.
pub static DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN: &[(&str, &[&str])] = &[
    ("gpt-5", &["gpt-5.5"]),
    ("gpt-5-pro", &["gpt-5.5-pro"]),
    ("gpt-5-chat-latest", &["gpt-5.5"]),
    ("gpt-5.5", &["gpt-5.4"]),
    ("gpt-5.5-pro", &["gpt-5.4"]),
    ("gpt-5.5-2026-04-23", &["gpt-5.4"]),
    ("gpt-5.5-pro-2026-04-23", &["gpt-5.4"]),
    ("gpt-5.5-20260423", &["gpt-5.4"]),
    ("gpt-5.5-pro-20260423", &["gpt-5.4"]),
    ("gpt-5.3-codex-spark", &["gpt-5.3-codex", "gpt-5.2-codex"]),
    ("gpt-5.3-codex", &["gpt-5.2-codex"]),
    ("codex-max", &["gpt-5.3-codex"]),
    ("gpt-5.1-codex-max", &["gpt-5.3-codex"]),
    ("codex-mini-latest", &["gpt-5.3-codex"]),
    ("gpt-5-codex-mini", &["gpt-5.3-codex"]),
    ("gpt-5.1-codex-mini", &["gpt-5.3-codex"]),
    ("gpt-5-codex", &["gpt-5.3-codex", "gpt-5.2-codex"]),
    ("gpt-5.2-codex", &["gpt-5.3-codex"]),
    ("gpt-5.1-codex", &["gpt-5.3-codex"]),
];

/// TS `UnsupportedCodexModelInfo`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UnsupportedCodexModelInfo {
    pub is_unsupported: bool,
    pub code: Option<String>,
    pub message: Option<String>,
    pub unsupported_model: Option<String>,
}

/// TS `ResolveUnsupportedCodexFallbackOptions`.
#[derive(Debug, Clone)]
pub struct ResolveUnsupportedCodexFallbackOptions<'a> {
    pub requested_model: Option<&'a str>,
    pub error_body: &'a Value,
    pub attempted_models: &'a [String],
    pub fallback_on_unsupported_codex_model: bool,
    pub fallback_to_gpt52_on_unsupported_gpt53: bool,
    /// Custom chain overrides (config getter output shape).
    pub custom_chain: Option<&'a FallbackChain>,
}

/// TS `canonicalizeModelName` (private there, behavior-critical here).
///
/// trim → lowercase → strip provider prefix (`split("/").pop()`) → strip
/// suffix `-(none|minimal|low|medium|high|xhigh)` ONLY (no `-max`/`-ultra`).
/// Empty → `None`.
pub(crate) fn canonicalize_model_name(model: Option<&str>) -> Option<String> {
    let trimmed = model?.trim().to_lowercase();
    if trimmed.is_empty() {
        return None;
    }
    let stripped = if trimmed.contains('/') {
        trimmed.rsplit('/').next().unwrap_or(&trimmed)
    } else {
        &trimmed
    };
    for suffix in ["-none", "-minimal", "-low", "-medium", "-high", "-xhigh"] {
        if let Some(base) = stripped.strip_suffix(suffix) {
            return Some(base.to_string());
        }
    }
    Some(stripped.to_string())
}

/// Ordered `Record<string, string[]>` analogue used by chain normalization.
fn chain_get<'a>(chain: &'a [(String, Vec<String>)], key: &str) -> Option<&'a [String]> {
    chain
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, targets)| targets.as_slice())
}

fn chain_set(chain: &mut Vec<(String, Vec<String>)>, key: String, values: Vec<String>) {
    if let Some(entry) = chain.iter_mut().find(|(k, _)| *k == key) {
        entry.1 = values;
    } else {
        chain.push((key, values));
    }
}

fn normalize_fallback_chain(custom_chain: Option<&FallbackChain>) -> Vec<(String, Vec<String>)> {
    let mut normalized: Vec<(String, Vec<String>)> = Vec::new();
    for (key, values) in DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN {
        let Some(normalized_key) = canonicalize_model_name(Some(key)) else {
            continue;
        };
        let normalized_values = values
            .iter()
            .filter_map(|value| canonicalize_model_name(Some(value)))
            .collect();
        chain_set(&mut normalized, normalized_key, normalized_values);
    }

    let Some(custom_chain) = custom_chain else {
        return normalized;
    };

    for (key, values) in custom_chain.0.iter() {
        let Some(normalized_key) = canonicalize_model_name(Some(key)) else {
            continue;
        };
        let normalized_values: Vec<String> = values
            .iter()
            .filter_map(|value| canonicalize_model_name(Some(value)))
            .collect();
        if !normalized_values.is_empty() {
            chain_set(&mut normalized, normalized_key, normalized_values);
        }
    }

    normalized
}

/// TS `extractUnsupportedCodexModelFromText(bodyText)`.
pub fn extract_unsupported_codex_model_from_text(body_text: &str) -> Option<String> {
    if let Some(captures) = direct_unsupported_model_pattern().captures(body_text)
        && let Some(model) = captures.get(1)
    {
        return canonicalize_model_name(Some(model.as_str()));
    }
    if let Some(captures) = normalized_unsupported_model_pattern().captures(body_text)
        && let Some(model) = captures.get(1)
    {
        return canonicalize_model_name(Some(model.as_str()));
    }
    if let Some(captures) = model_access_denied_pattern().captures(body_text)
        && let Some(model) = captures.get(1)
    {
        return canonicalize_model_name(Some(model.as_str()));
    }
    None
}

/// `@internal` in TS. Status must be 400 and the body non-empty, matching any
/// of the three unsupported-model patterns.
pub fn is_unsupported_codex_model_for_chatgpt(status: u16, body_text: &str) -> bool {
    if status != cma_core::constants::HTTP_STATUS.bad_request {
        return false;
    }
    if body_text.is_empty() {
        return false;
    }
    chatgpt_codex_unsupported_model_pattern().is_match(body_text)
        || normalized_unsupported_model_pattern().is_match(body_text)
        || model_access_denied_pattern().is_match(body_text)
}

fn matches_any_unsupported_pattern(text: &str) -> bool {
    chatgpt_codex_unsupported_model_pattern().is_match(text)
        || normalized_unsupported_model_pattern().is_match(text)
        || model_access_denied_pattern().is_match(text)
}

/// TS `getUnsupportedCodexModelInfo(errorBody)`.
pub fn get_unsupported_codex_model_info(error_body: &Value) -> UnsupportedCodexModelInfo {
    if !is_record(error_body) {
        return UnsupportedCodexModelInfo::default();
    }

    let maybe_error = error_body.get("error");
    let maybe_error_record = maybe_error.filter(|value| is_record(value));
    let Some(maybe_error) = maybe_error_record else {
        // Flat `{ "detail": "..." }` shape (Codex quota endpoint).
        let Some(detail) = error_body.get("detail").and_then(Value::as_str) else {
            return UnsupportedCodexModelInfo::default();
        };
        if !matches_any_unsupported_pattern(detail) {
            return UnsupportedCodexModelInfo::default();
        }
        return UnsupportedCodexModelInfo {
            is_unsupported: true,
            code: None,
            message: Some(detail.to_string()),
            unsupported_model: extract_unsupported_codex_model_from_text(detail),
        };
    };

    let code = maybe_error
        .get("code")
        .and_then(Value::as_str)
        .map(str::to_string);
    let message = maybe_error
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string);
    let unsupported_model_from_payload = maybe_error
        .get("unsupported_model")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let unsupported_model = match unsupported_model_from_payload {
        Some(payload_model) => canonicalize_model_name(Some(payload_model)),
        None => extract_unsupported_codex_model_from_text(message.as_deref().unwrap_or("")),
    };
    let is_unsupported = code.as_deref() == Some(CHATGPT_CODEX_UNSUPPORTED_MODEL_CODE)
        || message
            .as_deref()
            .map(matches_any_unsupported_pattern)
            .unwrap_or(false);

    UnsupportedCodexModelInfo {
        is_unsupported,
        code,
        message,
        unsupported_model,
    }
}

/// TS `resolveUnsupportedCodexFallbackModel(options)`.
pub fn resolve_unsupported_codex_fallback_model(
    options: &ResolveUnsupportedCodexFallbackOptions<'_>,
) -> Option<String> {
    if !options.fallback_on_unsupported_codex_model {
        return None;
    }

    let unsupported = get_unsupported_codex_model_info(options.error_body);
    if !unsupported.is_unsupported {
        return None;
    }

    let requested_model = canonicalize_model_name(options.requested_model);
    let current_model = requested_model.or(unsupported.unsupported_model)?;

    let mut attempted: Vec<String> = Vec::new();
    for model in options.attempted_models {
        if let Some(normalized) = canonicalize_model_name(Some(model))
            && !attempted.contains(&normalized)
        {
            attempted.push(normalized);
        }
    }

    let chain = normalize_fallback_chain(options.custom_chain);
    let targets = chain_get(&chain, &current_model)?;
    if targets.is_empty() {
        return None;
    }

    for target in targets {
        if !options.fallback_to_gpt52_on_unsupported_gpt53
            && current_model == "gpt-5.3-codex"
            && target == "gpt-5.2-codex"
        {
            continue;
        }
        if *target == current_model {
            continue;
        }
        if attempted.iter().any(|attempted| attempted == target) {
            continue;
        }
        return Some(target.clone());
    }

    None
}

/// TS `shouldFallbackToGpt52OnUnsupportedGpt53(requestedModel, errorBody)` —
/// true when the legacy `gpt-5.3-codex → gpt-5.2-codex` edge is available.
pub fn should_fallback_to_gpt52_on_unsupported_gpt53(
    requested_model: Option<&str>,
    error_body: &Value,
) -> bool {
    if canonicalize_model_name(requested_model).as_deref() != Some("gpt-5.3-codex") {
        return false;
    }

    resolve_unsupported_codex_fallback_model(&ResolveUnsupportedCodexFallbackOptions {
        requested_model,
        error_body,
        attempted_models: &[],
        fallback_on_unsupported_codex_model: true,
        fallback_to_gpt52_on_unsupported_gpt53: true,
        custom_chain: None,
    })
    .as_deref()
        == Some("gpt-5.2-codex")
}

/// TS `isEntitlementError(code, bodyText)` — subscription doesn't include the
/// feature ("usage_not_included"), which is NOT a temporary rate limit.
pub fn is_entitlement_error(code: &str, body_text: &str) -> bool {
    let haystack = format!("{code} {body_text}").to_lowercase();
    entitlement_pattern().is_match(&haystack)
}

fn workspace_disabled_patterns() -> &'static [Regex; 6] {
    static RES: OnceLock<[Regex; 6]> = OnceLock::new();
    RES.get_or_init(|| {
        [
            Regex::new(r"(?i)workspace.*(?:disabled|expired|deactivated|terminated)").unwrap(),
            Regex::new(
                r"(?i)account\s+(?:has\s+been|is)\s+(?:disabled|expired|deactivated|terminated|closed)",
            )
            .unwrap(),
            Regex::new(r"(?i)(?:workspace|org(?:anization)?).*no longer.*(?:active|available|valid)")
                .unwrap(),
            Regex::new(r"(?i)(?:workspace|org(?:anization)?).*has been.*(?:disabled|expired|closed)")
                .unwrap(),
            Regex::new(r"(?i)workspace.*(?:access|subscription).*expired").unwrap(),
            Regex::new(r"(?i)org(?:anization)?.*(?:disabled|expired|inactive)").unwrap(),
        ]
    })
}

fn deactivated_workspace_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\bdeactivated_workspace\b").unwrap())
}

const WORKSPACE_ERROR_CODES: &[&str] = &[
    "workspace_disabled",
    "workspace_expired",
    "workspace_terminated",
    "account_disabled",
    "account_expired",
    "organization_disabled",
];

fn split_code_tokens(normalized_code: &str) -> Vec<&str> {
    normalized_code
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .collect()
}

/// TS `isWorkspaceDisabledError(status, code, bodyText)`.
///
/// `code` is `unknown` in TS (strings, numbers, null all occur) — pass any
/// JSON value; only strings contribute a normalized code.
pub fn is_workspace_disabled_error(status: u16, code: &Value, body_text: &str) -> bool {
    let normalized_code = code
        .as_str()
        .map(|value| value.trim().to_lowercase())
        .unwrap_or_default();

    if status == 402 {
        let tokens = split_code_tokens(&normalized_code);
        return tokens.contains(&"deactivated_workspace")
            || deactivated_workspace_pattern().is_match(body_text);
    }

    if status != 403 {
        return false;
    }

    let haystack = format!("{normalized_code} {body_text}").to_lowercase();
    let tokens = split_code_tokens(&normalized_code);

    for pattern in workspace_disabled_patterns() {
        if pattern.is_match(&haystack) {
            return true;
        }
    }

    if WORKSPACE_ERROR_CODES.contains(&normalized_code.as_str()) {
        return true;
    }

    tokens
        .iter()
        .any(|token| WORKSPACE_ERROR_CODES.contains(token))
}

/// TS `createEntitlementErrorResponse(_bodyText)` — the bodyText argument is
/// ignored; the payload is fixed (spec 06 §26 error contract).
pub fn create_entitlement_error_response() -> SyntheticResponse {
    let message = "This model is not included in your ChatGPT subscription. \
Please check that your account or workspace has access to Codex models (Plus/Pro/Business/Enterprise). \
If you recently subscribed or switched workspaces, try logging out and back in with `codex-multi-auth login`.";

    let mut error = serde_json::Map::new();
    error.insert("message".into(), Value::String(message.to_string()));
    error.insert("type".into(), Value::String("entitlement_error".into()));
    error.insert("code".into(), Value::String("usage_not_included".into()));
    let mut payload = serde_json::Map::new();
    payload.insert("error".into(), Value::Object(error));

    let mut headers = http::HeaderMap::new();
    headers.insert(
        "content-type",
        "application/json; charset=utf-8".parse().unwrap(),
    );

    SyntheticResponse {
        status: 403,
        status_text: "Forbidden".into(),
        headers,
        body: serde_json::to_string(&Value::Object(payload)).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn resolve(
        requested_model: Option<&str>,
        error_body: &Value,
        attempted: &[&str],
        enabled: bool,
        legacy_edge: bool,
        custom_chain: Option<&FallbackChain>,
    ) -> Option<String> {
        let attempted: Vec<String> = attempted.iter().map(|s| s.to_string()).collect();
        resolve_unsupported_codex_fallback_model(&ResolveUnsupportedCodexFallbackOptions {
            requested_model,
            error_body,
            attempted_models: &attempted,
            fallback_on_unsupported_codex_model: enabled,
            fallback_to_gpt52_on_unsupported_gpt53: legacy_edge,
            custom_chain,
        })
    }

    #[test]
    fn is_entitlement_error_matches_codes_and_body_phrases() {
        assert!(is_entitlement_error("usage_not_included", ""));
        assert!(is_entitlement_error("", "Usage not included in your plan"));
        assert!(!is_entitlement_error("usage_limit_reached", ""));
        assert!(!is_entitlement_error("rate_limit_exceeded", ""));
        assert!(!is_entitlement_error("not_found", "Resource not found"));
    }

    #[test]
    fn workspace_disabled_403_messages_and_codes() {
        assert!(is_workspace_disabled_error(
            403,
            &json!(""),
            "Your workspace has been disabled"
        ));
        assert!(is_workspace_disabled_error(403, &json!(""), "Workspace expired"));
        assert!(is_workspace_disabled_error(
            403,
            &json!(""),
            "Account has been deactivated"
        ));
        assert!(is_workspace_disabled_error(403, &json!("workspace_disabled"), ""));
        assert!(is_workspace_disabled_error(
            403,
            &json!("workspace_expired"),
            "Some message"
        ));
        assert!(is_workspace_disabled_error(403, &json!("account_disabled"), ""));
        assert!(is_workspace_disabled_error(
            403,
            &json!("organization_disabled"),
            ""
        ));
    }

    #[test]
    fn workspace_disabled_matches_wrapped_tokens_not_partial_text() {
        assert!(is_workspace_disabled_error(
            403,
            &json!("error.workspace_disabled"),
            ""
        ));
        assert!(is_workspace_disabled_error(
            403,
            &json!("workspace_expired:error"),
            ""
        ));
        assert!(!is_workspace_disabled_error(
            403,
            &json!("error.usage_not_included"),
            ""
        ));
    }

    #[test]
    fn workspace_disabled_402_deactivated_workspace_signals() {
        assert!(is_workspace_disabled_error(402, &json!("deactivated_workspace"), ""));
        assert!(is_workspace_disabled_error(
            402,
            &json!("error.deactivated_workspace"),
            ""
        ));
        assert!(is_workspace_disabled_error(
            402,
            &json!(""),
            r#"{"error":{"code":"deactivated_workspace"}}"#
        ));
    }

    #[test]
    fn workspace_disabled_rejects_unsupported_statuses() {
        for status in [400u16, 401, 500] {
            assert!(!is_workspace_disabled_error(
                status,
                &json!(""),
                "Your workspace has been disabled"
            ));
        }
        assert!(!is_workspace_disabled_error(400, &json!("workspace_disabled"), ""));
        assert!(!is_workspace_disabled_error(402, &json!("payment_required"), ""));
        assert!(!is_workspace_disabled_error(
            402,
            &json!(""),
            "Your workspace has been disabled"
        ));
    }

    #[test]
    fn workspace_disabled_rejects_unrelated_403s() {
        assert!(!is_workspace_disabled_error(403, &json!(""), "Permission denied"));
        assert!(!is_workspace_disabled_error(403, &json!(""), "Not authorized"));
        assert!(!is_workspace_disabled_error(
            403,
            &json!("usage_not_included"),
            "Not in your plan"
        ));
    }

    #[test]
    fn workspace_disabled_classifies_numeric_codes_via_body_text() {
        assert!(is_workspace_disabled_error(403, &json!(402), "Workspace disabled"));
        assert!(!is_workspace_disabled_error(
            403,
            &json!(402),
            "Billing failed for your subscription"
        ));
        assert!(!is_workspace_disabled_error(403, &json!(0), ""));
    }

    #[test]
    fn workspace_disabled_rejects_billing_style_403s() {
        assert!(!is_workspace_disabled_error(403, &json!("billing_failed"), ""));
        assert!(!is_workspace_disabled_error(403, &json!("payment_required"), ""));
        assert!(!is_workspace_disabled_error(
            403,
            &json!(""),
            "Payment required to continue"
        ));
        assert!(!is_workspace_disabled_error(
            403,
            &json!(""),
            "Billing failed for your plan"
        ));
        assert!(!is_workspace_disabled_error(
            403,
            &json!(""),
            "Your billing account has expired"
        ));
        assert!(!is_workspace_disabled_error(
            403,
            &json!(""),
            "service account terminated"
        ));
        assert!(!is_workspace_disabled_error(403, &json!(""), "team plan inactive"));
    }

    #[test]
    fn entitlement_error_response_has_fixed_shape() {
        let response = create_entitlement_error_response();
        assert_eq!(response.status, 403);
        assert_eq!(response.status_text, "Forbidden");
        let json: Value = serde_json::from_str(&response.body).unwrap();
        assert_eq!(json["error"]["type"], "entitlement_error");
        assert_eq!(json["error"]["code"], "usage_not_included");
        assert!(
            json["error"]["message"]
                .as_str()
                .unwrap()
                .contains("ChatGPT subscription")
        );
    }

    #[test]
    fn canonicalize_strips_only_none_through_xhigh_suffixes() {
        // Spec 06 gotcha 5: -max/-ultra are NOT effort suffixes here.
        assert_eq!(
            canonicalize_model_name(Some("org/GPT-5.3-Codex-High")).as_deref(),
            Some("gpt-5.3-codex")
        );
        assert_eq!(
            canonicalize_model_name(Some("gpt-5.1-codex-max")).as_deref(),
            Some("gpt-5.1-codex-max")
        );
        assert_eq!(
            canonicalize_model_name(Some("gpt-5.6-sol-ultra")).as_deref(),
            Some("gpt-5.6-sol-ultra")
        );
        assert_eq!(canonicalize_model_name(Some("   ")), None);
        assert_eq!(canonicalize_model_name(None), None);
    }

    #[test]
    fn extracts_unsupported_model_from_all_wordings() {
        assert_eq!(
            extract_unsupported_codex_model_from_text(
                "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
            )
            .as_deref(),
            Some("gpt-5.3-codex-spark")
        );
        assert_eq!(
            extract_unsupported_codex_model_from_text(
                "The model 'gpt-5.3-codex' is not currently available for this ChatGPT account when using Codex OAuth.",
            )
            .as_deref(),
            Some("gpt-5.3-codex")
        );
        assert_eq!(
            extract_unsupported_codex_model_from_text(
                "The model `gpt-5.5` does not exist or you do not have access to it.",
            )
            .as_deref(),
            Some("gpt-5.5")
        );
    }

    #[test]
    fn unsupported_info_from_normalized_error_payload() {
        let info = get_unsupported_codex_model_info(&json!({
            "error": {
                "code": "model_not_supported_with_chatgpt_account",
                "message": "The model 'gpt-5.3-codex-spark' is not currently available for this ChatGPT account when using Codex OAuth.",
                "unsupported_model": "gpt-5.3-codex-spark",
            }
        }));
        assert!(info.is_unsupported);
        assert_eq!(info.unsupported_model.as_deref(), Some("gpt-5.3-codex-spark"));
    }

    #[test]
    fn unsupported_info_from_normalized_wording_without_code() {
        let info = get_unsupported_codex_model_info(&json!({
            "error": {
                "message": "The model 'gpt-5.3-codex' is not currently available for this chatgpt account.",
            }
        }));
        assert!(info.is_unsupported);
        assert_eq!(info.unsupported_model.as_deref(), Some("gpt-5.3-codex"));
    }

    #[test]
    fn unsupported_info_from_flat_detail_branch() {
        let info = get_unsupported_codex_model_info(&json!({
            "detail": "The model 'gpt-5.3-codex' is not currently available for this chatgpt account.",
        }));
        assert!(info.is_unsupported);
        assert_eq!(info.unsupported_model.as_deref(), Some("gpt-5.3-codex"));

        let info = get_unsupported_codex_model_info(&json!({
            "detail": "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
        }));
        assert!(info.is_unsupported);
        assert!(info.message.as_deref().unwrap().contains("gpt-5-codex"));
        assert_eq!(info.unsupported_model.as_deref(), Some("gpt-5-codex"));
    }

    #[test]
    fn unsupported_info_detail_with_null_error_and_placeholder_model() {
        let info = get_unsupported_codex_model_info(&json!({
            "error": null,
            "detail": "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
        }));
        assert!(info.is_unsupported);
        assert_eq!(info.unsupported_model.as_deref(), Some("gpt-5.3-codex"));

        let info = get_unsupported_codex_model_info(&json!({
            "detail": "model is not supported when using Codex with a ChatGPT account",
        }));
        assert!(info.is_unsupported);
        assert_eq!(info.unsupported_model, None);
    }

    #[test]
    fn unsupported_info_ignores_malformed_payloads() {
        assert!(!get_unsupported_codex_model_info(&Value::Null).is_unsupported);
        assert!(
            !get_unsupported_codex_model_info(&json!({ "error": "not-an-object" })).is_unsupported
        );
        let info = get_unsupported_codex_model_info(&json!({ "error": { "code": 123 } }));
        assert_eq!(info.code, None);
        assert_eq!(info.message, None);
        assert!(!info.is_unsupported);
        assert!(
            !get_unsupported_codex_model_info(&json!({ "detail": "you are not authorized" }))
                .is_unsupported
        );
        assert!(!get_unsupported_codex_model_info(&json!({ "detail": 42 })).is_unsupported);
    }

    #[test]
    fn resolves_spark_fallback_chain_to_current_codex_first() {
        let error_body = json!({
            "error": {
                "code": "model_not_supported_with_chatgpt_account",
                "message": "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
            }
        });
        assert_eq!(
            resolve(
                Some("gpt-5.3-codex-spark"),
                &error_body,
                &["gpt-5.3-codex-spark"],
                true,
                true,
                None,
            )
            .as_deref(),
            Some("gpt-5.3-codex")
        );

        let error_body = json!({
            "error": {
                "code": "model_not_supported_with_chatgpt_account",
                "message": "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
            }
        });
        assert_eq!(
            resolve(
                Some("gpt-5.3-codex"),
                &error_body,
                &["gpt-5.3-codex-spark", "gpt-5.3-codex", "gpt-5-codex"],
                true,
                true,
                None,
            )
            .as_deref(),
            Some("gpt-5.2-codex")
        );
    }

    #[test]
    fn respects_legacy_gpt52_toggle_when_disabled() {
        let error_body = json!({
            "error": {
                "code": "model_not_supported_with_chatgpt_account",
                "message": "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
            }
        });
        assert_eq!(
            resolve(Some("gpt-5.3-codex"), &error_body, &["gpt-5.3-codex"], true, false, None),
            None
        );
        assert_eq!(
            resolve(
                Some("gpt-5.3-codex"),
                &error_body,
                &["gpt-5.3-codex", "gpt-5-codex"],
                true,
                false,
                None,
            ),
            None
        );
    }

    #[test]
    fn resolves_gpt55_fallback_to_gpt54() {
        let unsupported = |model: &str| {
            json!({
                "error": {
                    "code": "model_not_supported_with_chatgpt_account",
                    "message": format!("The '{model}' model is not supported when using Codex with a ChatGPT account."),
                }
            })
        };
        assert_eq!(
            resolve(Some("gpt-5.5"), &unsupported("gpt-5.5"), &["gpt-5.5"], true, true, None)
                .as_deref(),
            Some("gpt-5.4")
        );
        assert_eq!(
            resolve(
                Some("gpt-5.5-pro-2026-04-23"),
                &unsupported("gpt-5.5-pro-2026-04-23"),
                &["gpt-5.5-pro-2026-04-23"],
                true,
                true,
                None,
            )
            .as_deref(),
            Some("gpt-5.4")
        );
        let access_denied = json!({
            "error": {
                "message": "The model `gpt-5.5` does not exist or you do not have access to it.",
            }
        });
        assert_eq!(
            resolve(Some("gpt-5.5"), &access_denied, &["gpt-5.5"], true, true, None).as_deref(),
            Some("gpt-5.4")
        );
    }

    #[test]
    fn resolves_stale_aliases_to_current_models() {
        let unsupported = |model: &str| {
            json!({
                "error": {
                    "code": "model_not_supported_with_chatgpt_account",
                    "message": format!("The '{model}' model is not supported when using Codex with a ChatGPT account."),
                }
            })
        };
        assert_eq!(
            resolve(Some("gpt-5"), &unsupported("gpt-5"), &["gpt-5"], true, true, None).as_deref(),
            Some("gpt-5.5")
        );
        assert_eq!(
            resolve(
                Some("gpt-5.1-codex-mini"),
                &unsupported("gpt-5.1-codex-mini"),
                &["gpt-5.1-codex-mini"],
                true,
                true,
                None,
            )
            .as_deref(),
            Some("gpt-5.3-codex")
        );
    }

    #[test]
    fn resolves_custom_chains_with_canonicalization() {
        let custom = FallbackChain(vec![
            (String::new(), vec!["gpt-5-codex".into()]),
            (
                "gpt-5.3-codex".into(),
                vec!["gpt-5.3-codex".into(), "gpt-5-codex-low".into()],
            ),
        ]);
        let error_body = json!({
            "error": {
                "code": "model_not_supported_with_chatgpt_account",
                "message": "not supported when using Codex with a ChatGPT account",
            }
        });
        let attempted = ["", "   ", "gpt-5.3-codex"];
        assert_eq!(
            resolve(
                Some("org/gpt-5.3-codex-high"),
                &error_body,
                &attempted,
                true,
                true,
                Some(&custom),
            )
            .as_deref(),
            Some("gpt-5-codex")
        );
    }

    #[test]
    fn returns_none_when_disabled_or_unresolvable() {
        let unsupported_error = json!({
            "error": { "code": "model_not_supported_with_chatgpt_account" }
        });
        assert_eq!(
            resolve(Some("gpt-5.3-codex"), &unsupported_error, &[], false, true, None),
            None
        );
        assert_eq!(resolve(None, &unsupported_error, &[], true, true, None), None);
        assert_eq!(
            resolve(Some("unknown-codex-model"), &unsupported_error, &[], true, true, None),
            None
        );
    }

    #[test]
    fn flags_gpt52_fallback_only_for_current_codex_unsupported_errors() {
        assert!(should_fallback_to_gpt52_on_unsupported_gpt53(
            Some("gpt-5.3-codex"),
            &json!({
                "error": {
                    "code": "model_not_supported_with_chatgpt_account",
                    "message": "not supported when using Codex with a ChatGPT account",
                }
            }),
        ));
        assert!(!should_fallback_to_gpt52_on_unsupported_gpt53(
            Some("gpt-5.2-codex"),
            &json!({ "error": { "code": "model_not_supported_with_chatgpt_account" } }),
        ));
        assert!(!should_fallback_to_gpt52_on_unsupported_gpt53(
            Some("gpt-5.3-codex"),
            &json!({ "error": { "code": "usage_not_included" } }),
        ));
    }
}
