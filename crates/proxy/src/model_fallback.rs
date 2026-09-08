//! Unsupported-model traversal + fallback chains (index.ts §5.5.3 step 3).
//!
//! Port of the model-fallback half of the `index.ts` custom-fetch state
//! machine (spec 13 §5.5.3, gotchas 9–11):
//!
//! - the **spark** forced-fallback rule (`gpt-5.3-codex-spark`, exact match
//!   OR substring) which additionally SKIPS the try-other-accounts-first
//!   traversal;
//! - the **gpt-5.5 family** forced-fallback rule (exact-match list of 6 ids
//!   incl. dateless, dashed-date and compact-date variants, pro and
//!   non-pro);
//! - the decision ladder: try other accounts first → resolve fallback model
//!   → strict block → bookkeeping-only;
//! - fallback body reconstruction: `{ ...transformedBody, model }` when a
//!   parsed body exists, else re-parse the raw request body and override
//!   `model`, else `{ "model": <fallback> }` alone (gotcha 10);
//! - `previousModel` defaulting to `"gpt-5.3-codex"` (gotcha 11).
//!
//! Everything here is pure — the pipeline applies the side effects
//! (entitlement blocks, capability records, token refunds, metrics).

use cma_core::schemas::plugin_config::FallbackChain;
use cma_request::error_classification::{
    ResolveUnsupportedCodexFallbackOptions, UnsupportedCodexModelInfo,
    resolve_unsupported_codex_fallback_model,
};
use serde_json::{Map, Value};

/// The spark model id (spec 13 §5.5.3): forced fallback, skips the
/// try-other-accounts-first traversal because spark is commonly unavailable
/// on non-Pro/Business workspaces.
pub const SPARK_MODEL: &str = "gpt-5.3-codex-spark";

/// The exact-match gpt-5.5 forced-fallback list (spec 13 gotcha 9). Order
/// matches the TS `||` chain in `index.ts`.
pub const GPT55_FORCED_FALLBACK_MODELS: [&str; 6] = [
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.5-2026-04-23",
    "gpt-5.5-pro-2026-04-23",
    "gpt-5.5-20260423",
    "gpt-5.5-pro-20260423",
];

/// `previousModel` default when `model` was undefined at fallback time
/// (spec 13 gotcha 11).
pub const DEFAULT_PREVIOUS_MODEL: &str = "gpt-5.3-codex";

/// TS `shouldForceSparkFallback` — exact match OR substring on the
/// lowercased blocked model name.
pub fn should_force_spark_fallback(blocked_model_lower: &str) -> bool {
    blocked_model_lower == SPARK_MODEL || blocked_model_lower.contains(SPARK_MODEL)
}

/// TS `shouldForceGpt55Fallback` — exact-match only against the 6-id list.
pub fn should_force_gpt55_fallback(blocked_model_lower: &str) -> bool {
    GPT55_FORCED_FALLBACK_MODELS.contains(&blocked_model_lower)
}

/// Inputs to [`plan_unsupported_model`] — everything the §5.5.3 step-3
/// ladder reads.
pub struct UnsupportedModelContext<'a> {
    /// `getUnsupportedCodexModelInfo(errorBody)` output.
    pub info: &'a UnsupportedCodexModelInfo,
    /// The raw error body (needed by the chain resolver).
    pub error_body: &'a Value,
    /// The request's current `model` (post any earlier fallback swap).
    pub model: Option<&'a str>,
    /// `attempted.size < max(1, accountCount)` at decision time.
    pub has_remaining_accounts: bool,
    /// Config: `unsupportedCodexPolicy === "fallback"`.
    pub fallback_on_unsupported_codex_model: bool,
    /// Config: `fallbackToGpt52OnUnsupportedGpt53`.
    pub fallback_to_gpt52_on_unsupported_gpt53: bool,
    /// Config: `unsupportedCodexFallbackChain` (custom chain overrides).
    pub custom_chain: Option<&'a FallbackChain>,
    /// Models already attempted via fallback restarts (outer-loop set).
    pub attempted_models: &'a [String],
}

/// The §5.5.3 step-3 decision. Side effects are listed per variant in the
/// order the TS applied them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnsupportedModelPlan {
    /// Error body is not an unsupported-model error: fall through to the
    /// remaining `!response.ok` ladder.
    NotUnsupported,
    /// Rotate to the next account before considering fallback (entitlements
    /// differ per account/workspace). Effects: `markBlocked(unsupported-model)`
    /// + `recordUnsupported` + refund + `recordFailure` (both stores) +
    ///   `forgetSession` + `lastSwitchReason = "rotation"` + set
    ///   `retryNextAccountBeforeFallback` and break the inner loop.
    TryOtherAccountsFirst { blocked_model: String },
    /// Swap models and restart the FULL account traversal. Effects:
    /// add both models to the attempted set, `markBlocked(previous)` +
    /// `recordUnsupported(previous)`, refund against the PREVIOUS
    /// family/model, rebuild the body, toast, set
    /// `restartAccountTraversalWithFallback`.
    Fallback {
        blocked_model: String,
        /// `model ?? "gpt-5.3-codex"` (gotcha 11).
        previous_model: String,
        fallback_model: String,
    },
    /// Strict policy blocked automatic fallback. Effects: `markBlocked` +
    /// `recordUnsupported` + toast; execution FALLS THROUGH to the generic
    /// error return.
    StrictBlock { blocked_model: String },
    /// Unsupported + fallback allowed + no remaining accounts + no fallback
    /// model resolved: `markBlocked` + `recordUnsupported` only, then fall
    /// through to the generic error return.
    BookkeepOnly { blocked_model: String },
}

/// The §5.5.3 step-3 ladder, verbatim ordering:
///
/// 1. not unsupported → [`UnsupportedModelPlan::NotUnsupported`];
/// 2. unsupported AND accounts remain AND NOT spark-forced →
///    [`UnsupportedModelPlan::TryOtherAccountsFirst`];
/// 3. `resolveUnsupportedCodexFallbackModel` (with
///    `fallbackOnUnsupportedCodexModel = allowUnsupportedFallback`) →
///    [`UnsupportedModelPlan::Fallback`];
/// 4. no fallback allowed → [`UnsupportedModelPlan::StrictBlock`];
/// 5. else → [`UnsupportedModelPlan::BookkeepOnly`].
pub fn plan_unsupported_model(ctx: &UnsupportedModelContext<'_>) -> UnsupportedModelPlan {
    if !ctx.info.is_unsupported {
        return UnsupportedModelPlan::NotUnsupported;
    }

    // blockedModel = info.unsupportedModel ?? model ?? "requested model"
    let blocked_model = ctx
        .info
        .unsupported_model
        .clone()
        .or_else(|| ctx.model.map(str::to_string))
        .unwrap_or_else(|| "requested model".to_string());
    let blocked_model_lower = blocked_model.to_lowercase();

    let force_spark = should_force_spark_fallback(&blocked_model_lower);
    let force_gpt55 = should_force_gpt55_fallback(&blocked_model_lower);
    let allow_unsupported_fallback =
        ctx.fallback_on_unsupported_codex_model || force_spark || force_gpt55;

    // Try other accounts first (entitlements differ per account/workspace).
    // Spark is special-cased to skip traversal (spec 13 gotcha 9).
    if ctx.has_remaining_accounts && !force_spark {
        return UnsupportedModelPlan::TryOtherAccountsFirst { blocked_model };
    }

    let fallback_model =
        resolve_unsupported_codex_fallback_model(&ResolveUnsupportedCodexFallbackOptions {
            requested_model: ctx.model,
            error_body: ctx.error_body,
            attempted_models: ctx.attempted_models,
            fallback_on_unsupported_codex_model: allow_unsupported_fallback,
            fallback_to_gpt52_on_unsupported_gpt53: ctx.fallback_to_gpt52_on_unsupported_gpt53,
            custom_chain: ctx.custom_chain,
        });

    if let Some(fallback_model) = fallback_model {
        let previous_model = ctx
            .model
            .map(str::to_string)
            .unwrap_or_else(|| DEFAULT_PREVIOUS_MODEL.to_string());
        return UnsupportedModelPlan::Fallback {
            blocked_model,
            previous_model,
            fallback_model,
        };
    }

    if !allow_unsupported_fallback {
        return UnsupportedModelPlan::StrictBlock { blocked_model };
    }

    UnsupportedModelPlan::BookkeepOnly { blocked_model }
}

/// Fallback body reconstruction (spec 13 gotchas 10–11).
///
/// - `transformed_body` is a JSON object → `{ ...transformedBody, model }`;
/// - else parse `raw_body` as JSON and override `model` (non-object parse
///   results fall through);
/// - parse failure → `{ "model": <fallback> }` alone.
///
/// Returns `(new_transformed_body, serialized_string)` — the serialized form
/// is what goes on the wire (TS `JSON.stringify`, compact).
pub fn rebuild_body_with_model(
    transformed_body: Option<&Value>,
    raw_body: &[u8],
    fallback_model: &str,
) -> (Value, String) {
    let with_model = |mut map: Map<String, Value>| -> Value {
        map.insert(
            "model".to_string(),
            Value::String(fallback_model.to_string()),
        );
        Value::Object(map)
    };

    let rebuilt = match transformed_body {
        Some(Value::Object(map)) => with_model(map.clone()),
        _ => match serde_json::from_slice::<Value>(raw_body) {
            Ok(Value::Object(map)) => with_model(map),
            // Parse failure (or non-object JSON): `{ model }` alone.
            _ => {
                let mut map = Map::new();
                map.insert(
                    "model".to_string(),
                    Value::String(fallback_model.to_string()),
                );
                Value::Object(map)
            }
        },
    };
    let serialized = serde_json::to_string(&rebuilt).unwrap_or_else(|_| {
        // Unreachable for Value inputs; keep the wire contract anyway.
        format!("{{\"model\":\"{fallback_model}\"}}")
    });
    (rebuilt, serialized)
}

/// FROZEN user-visible strings for the fallback paths (spec 13 §5.5.3;
/// gotcha 29 — byte-for-byte contract).
pub fn fallback_last_error(previous_model: &str, fallback_model: &str) -> String {
    format!("Model fallback: {previous_model} -> {fallback_model}")
}

/// Toast shown when a fallback model is applied.
pub fn fallback_toast_message(previous_model: &str, fallback_model: &str) -> String {
    format!(
        "Model {previous_model} is not available for this account. Retrying with {fallback_model}."
    )
}

/// Toast shown when strict policy blocks automatic fallback.
pub fn strict_block_toast_message(blocked_model: &str) -> String {
    format!(
        "Model {blocked_model} is not available for this account. Strict policy blocked automatic fallback."
    )
}

/// `lastError` for the rotate-before-fallback path.
pub fn unsupported_rotation_last_error(account_number: i64, blocked_model: &str) -> String {
    format!("Unsupported model on account {account_number}: {blocked_model}")
}

/// `lastError` for the strict-block path.
pub fn strict_block_last_error(blocked_model: &str) -> String {
    format!("Unsupported model (strict): {blocked_model}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_request::error_classification::get_unsupported_codex_model_info;
    use serde_json::json;

    fn unsupported_body(model: &str) -> Value {
        json!({
            "error": {
                "code": "model_not_supported_with_chatgpt_account",
                "message": format!(
                    "The '{model}' model is not supported when using Codex with a ChatGPT account."
                ),
            }
        })
    }

    fn ctx<'a>(
        info: &'a UnsupportedCodexModelInfo,
        error_body: &'a Value,
        model: Option<&'a str>,
        has_remaining_accounts: bool,
        fallback_enabled: bool,
        attempted: &'a [String],
    ) -> UnsupportedModelContext<'a> {
        UnsupportedModelContext {
            info,
            error_body,
            model,
            has_remaining_accounts,
            fallback_on_unsupported_codex_model: fallback_enabled,
            fallback_to_gpt52_on_unsupported_gpt53: true,
            custom_chain: None,
            attempted_models: attempted,
        }
    }

    #[test]
    fn not_unsupported_error_falls_through() {
        let body = json!({"error": {"message": "boom"}});
        let info = get_unsupported_codex_model_info(&body);
        let attempted: Vec<String> = vec![];
        let plan = plan_unsupported_model(&ctx(
            &info,
            &body,
            Some("gpt-5.3-codex"),
            true,
            true,
            &attempted,
        ));
        assert_eq!(plan, UnsupportedModelPlan::NotUnsupported);
    }

    #[test]
    fn tries_other_accounts_before_fallback_when_accounts_remain() {
        let body = unsupported_body("gpt-5.3-codex");
        let info = get_unsupported_codex_model_info(&body);
        let attempted = vec!["gpt-5.3-codex".to_string()];
        let plan = plan_unsupported_model(&ctx(
            &info,
            &body,
            Some("gpt-5.3-codex"),
            true,
            true,
            &attempted,
        ));
        assert!(matches!(
            plan,
            UnsupportedModelPlan::TryOtherAccountsFirst { ref blocked_model }
                if blocked_model == "gpt-5.3-codex"
        ));
    }

    #[test]
    fn spark_skips_account_traversal_even_with_accounts_remaining() {
        // Spec 13 gotcha 9: spark goes straight to fallback.
        let body = unsupported_body(SPARK_MODEL);
        let info = get_unsupported_codex_model_info(&body);
        let attempted = vec![SPARK_MODEL.to_string()];
        let plan = plan_unsupported_model(&ctx(
            &info,
            &body,
            Some(SPARK_MODEL),
            true,
            false,
            &attempted,
        ));
        match plan {
            UnsupportedModelPlan::Fallback {
                blocked_model,
                previous_model,
                fallback_model,
            } => {
                assert_eq!(blocked_model, SPARK_MODEL);
                assert_eq!(previous_model, SPARK_MODEL);
                assert_ne!(fallback_model, SPARK_MODEL);
            }
            other => panic!("expected Fallback, got {other:?}"),
        }
    }

    #[test]
    fn spark_substring_matches_force_fallback() {
        assert!(should_force_spark_fallback("openai/gpt-5.3-codex-spark"));
        assert!(should_force_spark_fallback(SPARK_MODEL));
        assert!(!should_force_spark_fallback("gpt-5.3-codex"));
    }

    #[test]
    fn gpt55_forced_fallback_list_is_exact_match_only() {
        for id in GPT55_FORCED_FALLBACK_MODELS {
            assert!(should_force_gpt55_fallback(id), "{id} must force fallback");
        }
        // Exact-match only: substrings and other variants do NOT force.
        assert!(!should_force_gpt55_fallback("gpt-5.5-something"));
        assert!(!should_force_gpt55_fallback("openai/gpt-5.5"));
        assert!(!should_force_gpt55_fallback("gpt-5.4"));
    }

    #[test]
    fn gpt55_forces_fallback_under_strict_policy() {
        // Port of index.test.ts "forces GPT-5.5 fallback to gpt-5.4 even when
        // strict policy disables generic unsupported fallback".
        let body = unsupported_body("gpt-5.5");
        let info = get_unsupported_codex_model_info(&body);
        let attempted = vec!["gpt-5.5".to_string()];
        let plan = plan_unsupported_model(&ctx(
            &info,
            &body,
            Some("gpt-5.5"),
            false,
            false,
            &attempted,
        ));
        assert!(
            matches!(plan, UnsupportedModelPlan::Fallback { .. }),
            "expected forced fallback, got {plan:?}"
        );
    }

    #[test]
    fn strict_policy_blocks_generic_fallback() {
        let body = unsupported_body("gpt-5.3-codex");
        let info = get_unsupported_codex_model_info(&body);
        let attempted = vec!["gpt-5.3-codex".to_string()];
        let plan = plan_unsupported_model(&ctx(
            &info,
            &body,
            Some("gpt-5.3-codex"),
            false,
            false,
            &attempted,
        ));
        assert!(matches!(plan, UnsupportedModelPlan::StrictBlock { .. }));
    }

    #[test]
    fn previous_model_defaults_to_gpt53_codex() {
        // Gotcha 11: previousModel defaults when model was undefined.
        let body = unsupported_body("gpt-5.3-codex");
        let info = get_unsupported_codex_model_info(&body);
        let attempted: Vec<String> = vec![];
        let plan = plan_unsupported_model(&ctx(&info, &body, None, false, true, &attempted));
        if let UnsupportedModelPlan::Fallback { previous_model, .. } = plan {
            assert_eq!(previous_model, DEFAULT_PREVIOUS_MODEL);
        } else {
            panic!("expected Fallback, got {plan:?}");
        }
    }

    #[test]
    fn rebuild_body_prefers_transformed_body() {
        let transformed = json!({"model": "gpt-5.3-codex", "stream": true, "input": []});
        let (value, serialized) =
            rebuild_body_with_model(Some(&transformed), b"ignored", "gpt-5.2-codex");
        assert_eq!(value["model"], "gpt-5.2-codex");
        assert_eq!(value["stream"], true);
        assert!(serialized.contains("\"gpt-5.2-codex\""));
    }

    #[test]
    fn rebuild_body_parses_raw_body_when_no_transformed_body() {
        let raw = br#"{"model":"gpt-5.3-codex","instructions":"keep me"}"#;
        let (value, _) = rebuild_body_with_model(None, raw, "gpt-5.2-codex");
        assert_eq!(value["model"], "gpt-5.2-codex");
        assert_eq!(value["instructions"], "keep me");
    }

    #[test]
    fn rebuild_body_parse_failure_sends_model_alone() {
        // Gotcha 10: parse failure → `{ "model": <fallback> }` alone.
        let (value, serialized) = rebuild_body_with_model(None, b"not json", "gpt-5.2-codex");
        assert_eq!(value, json!({"model": "gpt-5.2-codex"}));
        assert_eq!(serialized, "{\"model\":\"gpt-5.2-codex\"}");
    }

    #[test]
    fn frozen_strings() {
        assert_eq!(fallback_last_error("a", "b"), "Model fallback: a -> b");
        assert_eq!(
            fallback_toast_message("a", "b"),
            "Model a is not available for this account. Retrying with b."
        );
        assert_eq!(
            strict_block_toast_message("m"),
            "Model m is not available for this account. Strict policy blocked automatic fallback."
        );
        assert_eq!(
            unsupported_rotation_last_error(2, "m"),
            "Unsupported model on account 2: m"
        );
        assert_eq!(strict_block_last_error("m"), "Unsupported model (strict): m");
    }
}
