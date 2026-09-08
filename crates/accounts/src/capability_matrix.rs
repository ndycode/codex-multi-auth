//! Port of `lib/model-capability-matrix.ts` — pure, read-only builder of a
//! diagnostic account × model availability matrix (spec 03 §6).
//!
//! Behavior contracts (spec 03 §6 + gotchas 19/21/22):
//! - `account_index` is 1-BASED (display convention); `account_label` is
//!   literally `"Account {index+1}"` with no email/label enrichment.
//! - `account_key` comes from `crate::account_policy::get_account_policy_key`
//!   (`"sha256:…"`); entitlement blocks are probed under BOTH the policy key
//!   and the entitlement key, in that order (first live block wins).
//! - quota-forecast-01 fix (deliberate): capability snapshots/boosts are read
//!   under the ENTITLEMENT key, not the sha256 policy key — the write sites
//!   (`record_unsupported` etc.) key by `resolve_entitlement_account_key`, so
//!   the sha256 key would never match. Do not "simplify" back.
//! - Reasons order: "account disabled" → "entitlement blocked: <reason>" →
//!   "capability policy has unsupported failures" → "quota cache is
//!   rate-limited". `available` = no reasons.
//!
//! Layering note: the TS imports `MODEL_PROFILES` / `resolveNormalizedModel`
//! from `request/helpers/model-map.ts` (L3) and the quota-cache lookup from
//! the quota cluster (L4) — both ABOVE this crate in the DAG. The Rust port
//! therefore takes them as inputs: a [`ModelProfileProvider`] (implemented by
//! `cma-request` over its profile tables) and a pre-resolved per-account
//! quota entry slice (the caller runs `findQuotaCacheEntryForAccount`; the
//! TS recomputed it per model but the result is model-independent).

use cma_core::constants::ModelReasoningEffort;
use cma_core::model_family::PromptModelFamily;
use cma_core::schemas::account_storage::AccountStorageV3;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::account_policy::get_account_policy_key;
use crate::capability_policy::{CapabilityPolicySnapshot, CapabilityPolicyStore};
use crate::entitlement_cache::{
    EntitlementAccountRef, EntitlementCacheSnapshot, resolve_entitlement_account_key,
};

/// TS `ModelCapabilities` from `model-map.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCapabilitiesInfo {
    #[serde(rename = "toolSearch")]
    pub tool_search: bool,
    #[serde(rename = "computerUse")]
    pub computer_use: bool,
    pub compaction: bool,
}

/// The slice of a `cma-request` model profile the matrix needs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MatrixModelProfile {
    #[serde(rename = "normalizedModel")]
    pub normalized_model: String,
    #[serde(rename = "promptFamily")]
    pub prompt_family: PromptModelFamily,
    #[serde(rename = "defaultReasoningEffort")]
    pub default_reasoning_effort: ModelReasoningEffort,
    #[serde(rename = "supportedReasoningEfforts")]
    pub supported_reasoning_efforts: Vec<ModelReasoningEffort>,
    pub capabilities: ModelCapabilitiesInfo,
}

/// Model-profile catalog seam (production impl lives in
/// `cma-request::model_map`; see the module docs).
pub trait ModelProfileProvider {
    /// `Object.keys(MODEL_PROFILES)` — the default model list, in table
    /// order.
    fn default_models(&self) -> Vec<String>;
    /// TS `resolveNormalizedModel`.
    fn resolve_normalized_model(&self, model: &str) -> String;
    /// `MODEL_PROFILES[model]` — exact-key profile lookup.
    fn profile(&self, model: &str) -> Option<MatrixModelProfile>;
}

/// TS `ModelCapabilityMatrixEntry`. Serializes with the exact TS field names;
/// absent `entitlement_reason` / `capability_policy` / `quota` serialize as
/// `null` (matching `JSON.stringify` of the TS object).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelCapabilityMatrixEntry {
    /// 1-BASED (`index + 1`) — display convention (spec gotcha 21).
    #[serde(rename = "accountIndex")]
    pub account_index: usize,
    /// Literally `"Account {index+1}"`.
    #[serde(rename = "accountLabel")]
    pub account_label: String,
    /// `get_account_policy_key` output (`"sha256:…"`).
    #[serde(rename = "accountKey")]
    pub account_key: String,
    /// Normalized model (list element).
    pub model: String,
    #[serde(rename = "normalizedModel")]
    pub normalized_model: String,
    #[serde(rename = "promptFamily")]
    pub prompt_family: PromptModelFamily,
    #[serde(rename = "defaultReasoningEffort")]
    pub default_reasoning_effort: ModelReasoningEffort,
    #[serde(rename = "supportedReasoningEfforts")]
    pub supported_reasoning_efforts: Vec<ModelReasoningEffort>,
    pub capabilities: ModelCapabilitiesInfo,
    #[serde(rename = "entitlementBlocked")]
    pub entitlement_blocked: bool,
    #[serde(rename = "entitlementReason")]
    pub entitlement_reason: Option<String>,
    #[serde(rename = "entitlementWaitMs")]
    pub entitlement_wait_ms: i64,
    #[serde(rename = "capabilityPolicy")]
    pub capability_policy: Option<CapabilityPolicySnapshot>,
    #[serde(rename = "capabilityBoost", serialize_with = "serialize_js_number")]
    pub capability_boost: f64,
    /// Opaque quota-cache entry (`QuotaCacheEntry`-shaped JSON), passed
    /// through untouched.
    pub quota: Option<Value>,
    /// `reasons.is_empty()`.
    pub available: bool,
    pub reasons: Vec<String>,
}

/// TS `ModelCapabilityMatrix`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelCapabilityMatrix {
    #[serde(rename = "generatedAt")]
    pub generated_at: i64,
    pub models: Vec<String>,
    pub entries: Vec<ModelCapabilityMatrixEntry>,
}

/// Inputs for [`build_model_capability_matrix`] (TS single input object).
#[derive(Default)]
pub struct ModelCapabilityMatrixInput<'a> {
    pub storage: Option<&'a AccountStorageV3>,
    /// Model list; `None`/empty falls back to the provider's default models.
    pub models: Option<&'a [String]>,
    pub entitlements: Option<&'a EntitlementCacheSnapshot>,
    pub capability_policy: Option<&'a CapabilityPolicyStore>,
    /// Pre-resolved quota-cache entry per STORAGE account position (the TS
    /// called `findQuotaCacheEntryForAccount(quotaCache, account, accounts)`
    /// inline; the result is model-independent, so the caller resolves it
    /// once per account). `None` ⇔ the TS `quotaCache` being absent.
    pub quota_by_account: Option<&'a [Option<Value>]>,
    /// Epoch ms; `None` → `cma_core::utils::now_ms()`.
    pub now: Option<i64>,
}

struct EntitlementBlockView {
    blocked: bool,
    wait_ms: i64,
    reason: Option<String>,
}

/// TS `getEntitlementBlock` — for each key IN ORDER, find a block whose
/// `model` matches; only a live one (`blockedUntil > now`) wins; an expired
/// first match falls through to the NEXT KEY (not the next block).
fn get_entitlement_block(
    snapshot: Option<&EntitlementCacheSnapshot>,
    account_keys: &[String],
    normalized_model: &str,
    now: i64,
) -> EntitlementBlockView {
    let not_blocked = EntitlementBlockView {
        blocked: false,
        wait_ms: 0,
        reason: None,
    };
    let Some(snapshot) = snapshot else {
        return not_blocked;
    };
    for account_key in account_keys {
        let blocks = snapshot.get(account_key).unwrap_or(&[]);
        let block = blocks.iter().find(|entry| entry.model == normalized_model);
        let Some(block) = block else { continue };
        if block.blocked_until <= now {
            continue;
        }
        return EntitlementBlockView {
            blocked: true,
            wait_ms: (block.blocked_until - now).max(0),
            reason: Some(block.reason.as_str().to_string()),
        };
    }
    not_blocked
}

/// TS `buildModelCapabilityMatrix` — pure, read-only join over storage,
/// entitlements, capability policy and quota cache.
pub fn build_model_capability_matrix(
    provider: &dyn ModelProfileProvider,
    input: &ModelCapabilityMatrixInput<'_>,
) -> ModelCapabilityMatrix {
    let now = input.now.unwrap_or_else(cma_core::utils::now_ms);

    let raw_models: Vec<String> = match input.models {
        Some(models) if !models.is_empty() => models.to_vec(),
        _ => provider.default_models(),
    };
    let mut models: Vec<String> = raw_models
        .iter()
        .map(|model| provider.resolve_normalized_model(model))
        .collect();
    // Dedup keeping first occurrence, then sort lexicographically (JS default
    // sort; identical for the ASCII model-id space).
    let mut seen = std::collections::HashSet::new();
    models.retain(|model| seen.insert(model.clone()));
    models.sort();

    let empty: [cma_core::schemas::account_storage::AccountMetadataV3; 0] = [];
    let accounts = input
        .storage
        .map(|storage| storage.accounts.as_slice())
        .unwrap_or(&empty);

    let mut entries: Vec<ModelCapabilityMatrixEntry> = Vec::new();
    for (index, account) in accounts.iter().enumerate() {
        let account_key = get_account_policy_key(account, index);
        let entitlement_key = resolve_entitlement_account_key(&EntitlementAccountRef {
            account_id: account.account_id.clone(),
            email: account.email.clone(),
            refresh_token: None,
            index: Some(index as i64),
        });
        let entitlement_keys = [account_key.clone(), entitlement_key.clone()];

        for model in &models {
            let profile = provider
                .profile(model)
                .or_else(|| provider.profile(&provider.resolve_normalized_model(model)));
            // Skip the entry entirely when no profile resolves.
            let Some(profile) = profile else { continue };

            let entitlement = get_entitlement_block(
                input.entitlements,
                &entitlement_keys,
                &profile.normalized_model,
                now,
            );
            // quota-forecast-01: read under the ENTITLEMENT key (see module
            // docs) — the sha256 policy key would never match the write key.
            let capability_policy = input
                .capability_policy
                .and_then(|store| store.get_snapshot(&entitlement_key, &profile.normalized_model));
            let capability_boost = input
                .capability_policy
                .map(|store| store.get_boost(&entitlement_key, &profile.normalized_model, now))
                .unwrap_or(0.0);
            let quota = match (input.quota_by_account, input.storage) {
                (Some(quota_by_account), Some(_)) => {
                    quota_by_account.get(index).and_then(Clone::clone)
                }
                _ => None,
            };

            let mut reasons: Vec<String> = Vec::new();
            if account.enabled == Some(false) {
                reasons.push("account disabled".to_string());
            }
            if entitlement.blocked {
                reasons.push(format!(
                    "entitlement blocked: {}",
                    entitlement.reason.as_deref().unwrap_or("unknown")
                ));
            }
            if let Some(snapshot) = &capability_policy
                && snapshot.unsupported > 0
            {
                reasons.push("capability policy has unsupported failures".to_string());
            }
            if quota
                .as_ref()
                .and_then(|entry| entry.get("status"))
                .and_then(Value::as_i64)
                == Some(429)
            {
                reasons.push("quota cache is rate-limited".to_string());
            }

            entries.push(ModelCapabilityMatrixEntry {
                account_index: index + 1,
                account_label: format!("Account {}", index + 1),
                account_key: account_key.clone(),
                model: model.clone(),
                normalized_model: profile.normalized_model.clone(),
                prompt_family: profile.prompt_family,
                default_reasoning_effort: profile.default_reasoning_effort,
                supported_reasoning_efforts: profile.supported_reasoning_efforts.clone(),
                capabilities: profile.capabilities,
                entitlement_blocked: entitlement.blocked,
                entitlement_reason: entitlement.reason,
                entitlement_wait_ms: entitlement.wait_ms,
                capability_policy,
                capability_boost,
                quota,
                available: reasons.is_empty(),
                reasons,
            });
        }
    }

    ModelCapabilityMatrix {
        generated_at: now,
        models,
        entries,
    }
}

/// Serialize an f64 the way `JSON.stringify` prints a JS number: integral
/// values emit without a fractional part (`3`, not `3.0`).
fn serialize_js_number<S: serde::Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

// ============================================================================
// Tests — ported from test/model-capability-matrix.test.ts
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::model_family::ModelFamily;
    use cma_core::schemas::account_storage::AccountMetadataV3;
    use serde_json::json;

    /// Minimal stand-in for the `cma-request` profile tables covering the ids
    /// the ported assertions exercise.
    struct TestProvider;

    fn profile(normalized: &str, family: ModelFamily) -> MatrixModelProfile {
        MatrixModelProfile {
            normalized_model: normalized.to_string(),
            prompt_family: family,
            default_reasoning_effort: ModelReasoningEffort::Medium,
            supported_reasoning_efforts: vec![
                ModelReasoningEffort::Low,
                ModelReasoningEffort::Medium,
                ModelReasoningEffort::High,
            ],
            capabilities: ModelCapabilitiesInfo {
                tool_search: true,
                computer_use: false,
                compaction: true,
            },
        }
    }

    impl ModelProfileProvider for TestProvider {
        fn default_models(&self) -> Vec<String> {
            vec!["gpt-5.3-codex".to_string(), "gpt-5.5".to_string()]
        }

        fn resolve_normalized_model(&self, model: &str) -> String {
            match model {
                "gpt-5.3-codex" | "gpt-5-codex" | "codex" => "gpt-5.3-codex".to_string(),
                "gpt-5.5" => "gpt-5.5".to_string(),
                other => other.to_string(),
            }
        }

        fn profile(&self, model: &str) -> Option<MatrixModelProfile> {
            match model {
                "gpt-5.3-codex" => Some(profile("gpt-5.3-codex", ModelFamily::Gpt5Codex)),
                "gpt-5.5" => Some(profile("gpt-5.5", ModelFamily::Gpt5_2)),
                _ => None,
            }
        }
    }

    fn storage() -> AccountStorageV3 {
        let mut storage = AccountStorageV3::empty();
        let mut account = AccountMetadataV3::new("refresh", 1, 1);
        account.email = Some("owner@example.com".to_string());
        account.account_id = Some("acct_1".to_string());
        storage.accounts = vec![account];
        storage
    }

    fn entitlement_key() -> String {
        resolve_entitlement_account_key(&EntitlementAccountRef {
            account_id: Some("acct_1".to_string()),
            email: Some("owner@example.com".to_string()),
            refresh_token: None,
            index: Some(0),
        })
    }

    #[test]
    fn returns_default_normalized_models_without_entries_when_storage_is_missing() {
        let models: [String; 0] = [];
        let matrix = build_model_capability_matrix(
            &TestProvider,
            &ModelCapabilityMatrixInput {
                storage: None,
                models: Some(&models),
                now: Some(100),
                ..Default::default()
            },
        );

        assert_eq!(matrix.generated_at, 100);
        assert!(!matrix.models.is_empty());
        assert!(matrix.entries.is_empty());
    }

    #[test]
    fn builds_model_account_availability_from_existing_model_profiles() {
        let storage = storage();
        let models = vec!["gpt-5.3-codex".to_string()];
        let matrix = build_model_capability_matrix(
            &TestProvider,
            &ModelCapabilityMatrixInput {
                storage: Some(&storage),
                models: Some(&models),
                now: Some(100),
                ..Default::default()
            },
        );

        assert_eq!(matrix.models, vec!["gpt-5.3-codex".to_string()]);
        let entry = &matrix.entries[0];
        assert_eq!(entry.account_index, 1);
        assert_eq!(entry.account_label, "Account 1");
        assert_eq!(entry.normalized_model, "gpt-5.3-codex");
        assert_eq!(entry.prompt_family, ModelFamily::Gpt5Codex);
        assert!(entry.available);
        assert!(entry.account_key.starts_with("sha256:"));
    }

    #[test]
    fn marks_capability_policy_and_quota_cache_issues_unavailable() {
        let mut capability_policy = CapabilityPolicyStore::new();
        capability_policy.record_unsupported(&entitlement_key(), "gpt-5.3-codex", 100);

        let storage = storage();
        let models = vec!["gpt-5.3-codex".to_string()];
        let quota = vec![Some(json!({
            "updatedAt": 100,
            "status": 429,
            "model": "gpt-5.3-codex",
            "primary": {},
            "secondary": {},
        }))];
        let matrix = build_model_capability_matrix(
            &TestProvider,
            &ModelCapabilityMatrixInput {
                storage: Some(&storage),
                models: Some(&models),
                capability_policy: Some(&capability_policy),
                quota_by_account: Some(&quota),
                now: Some(100),
                ..Default::default()
            },
        );

        let entry = &matrix.entries[0];
        assert!(!entry.available);
        assert!(
            entry
                .reasons
                .contains(&"capability policy has unsupported failures".to_string())
        );
        assert!(entry.reasons.contains(&"quota cache is rate-limited".to_string()));
    }

    #[test]
    fn surfaces_capability_snapshots_recorded_under_the_entitlement_key() {
        // quota-forecast-01 regression: recordUnsupported writes under the
        // entitlement key, so the matrix must read with that same key.
        let mut capability_policy = CapabilityPolicyStore::new();
        capability_policy.record_unsupported(&entitlement_key(), "gpt-5.3-codex", 100);

        let storage = storage();
        let models = vec!["gpt-5.3-codex".to_string()];
        let matrix = build_model_capability_matrix(
            &TestProvider,
            &ModelCapabilityMatrixInput {
                storage: Some(&storage),
                models: Some(&models),
                capability_policy: Some(&capability_policy),
                now: Some(100),
                ..Default::default()
            },
        );

        let entry = &matrix.entries[0];
        let snapshot = entry.capability_policy.as_ref().expect("snapshot surfaces");
        assert!(snapshot.unsupported > 0);
        assert!(!entry.available);
        assert!(
            entry
                .reasons
                .contains(&"capability policy has unsupported failures".to_string())
        );
    }

    #[test]
    fn surfaces_a_negative_capability_boost_from_record_failure_under_the_entitlement_key() {
        let mut capability_policy = CapabilityPolicyStore::new();
        capability_policy.record_failure(&entitlement_key(), "gpt-5.3-codex", 100);

        let storage = storage();
        let models = vec!["gpt-5.3-codex".to_string()];
        let matrix = build_model_capability_matrix(
            &TestProvider,
            &ModelCapabilityMatrixInput {
                storage: Some(&storage),
                models: Some(&models),
                capability_policy: Some(&capability_policy),
                now: Some(100),
                ..Default::default()
            },
        );

        // failurePenalty = 3 (1 failure * 3), no successes → net boost -3.
        assert!(matrix.entries[0].capability_boost < 0.0);
    }

    #[test]
    fn record_success_under_the_entitlement_key_lifts_the_capability_boost_back_positive() {
        let mut capability_policy = CapabilityPolicyStore::new();
        capability_policy.record_failure(&entitlement_key(), "gpt-5.3-codex", 100);
        capability_policy.record_success(&entitlement_key(), "gpt-5.3-codex", 100);

        let storage = storage();
        let models = vec!["gpt-5.3-codex".to_string()];
        let matrix = build_model_capability_matrix(
            &TestProvider,
            &ModelCapabilityMatrixInput {
                storage: Some(&storage),
                models: Some(&models),
                capability_policy: Some(&capability_policy),
                now: Some(100),
                ..Default::default()
            },
        );

        assert!(matrix.entries[0].capability_boost > 0.0);
    }

    #[test]
    fn marks_disabled_and_entitlement_blocked_accounts_unavailable() {
        let mut base_storage = storage();
        base_storage.accounts[0].enabled = Some(false);

        use crate::entitlement_cache::{EntitlementBlock, EntitlementBlockReason};
        let entitlements = EntitlementCacheSnapshot::new(vec![(
            entitlement_key(),
            vec![EntitlementBlock {
                model: "gpt-5.3-codex".to_string(),
                blocked_until: 200,
                reason: EntitlementBlockReason::PlanEntitlement,
                updated_at: 100,
            }],
        )]);

        let models = vec!["gpt-5.3-codex".to_string()];
        let matrix = build_model_capability_matrix(
            &TestProvider,
            &ModelCapabilityMatrixInput {
                storage: Some(&base_storage),
                models: Some(&models),
                entitlements: Some(&entitlements),
                now: Some(100),
                ..Default::default()
            },
        );

        let entry = &matrix.entries[0];
        assert!(!entry.available);
        assert!(entry.entitlement_blocked);
        assert_eq!(entry.entitlement_reason.as_deref(), Some("plan-entitlement"));
        assert_eq!(entry.entitlement_wait_ms, 100);
        assert!(entry.reasons.contains(&"account disabled".to_string()));
        assert!(
            entry
                .reasons
                .contains(&"entitlement blocked: plan-entitlement".to_string())
        );
    }

    #[test]
    fn dedups_and_sorts_the_model_list() {
        let storage = storage();
        let models = vec![
            "gpt-5.5".to_string(),
            "gpt-5-codex".to_string(),
            "gpt-5.3-codex".to_string(),
        ];
        let matrix = build_model_capability_matrix(
            &TestProvider,
            &ModelCapabilityMatrixInput {
                storage: Some(&storage),
                models: Some(&models),
                now: Some(100),
                ..Default::default()
            },
        );
        // gpt-5-codex and gpt-5.3-codex both resolve to gpt-5.3-codex →
        // dedup; sorted ascending.
        assert_eq!(
            matrix.models,
            vec!["gpt-5.3-codex".to_string(), "gpt-5.5".to_string()]
        );
        assert_eq!(matrix.entries.len(), 2);
    }

    #[test]
    fn capability_boost_serializes_like_a_js_number() {
        // Integral f64 must serialize without a fractional part.
        #[derive(Serialize)]
        struct Probe {
            #[serde(serialize_with = "super::serialize_js_number")]
            boost: f64,
        }
        assert_eq!(
            serde_json::to_string(&Probe { boost: -3.0 }).unwrap(),
            "{\"boost\":-3}"
        );
        assert_eq!(
            serde_json::to_string(&Probe { boost: 2.5 }).unwrap(),
            "{\"boost\":2.5}"
        );
    }
}
