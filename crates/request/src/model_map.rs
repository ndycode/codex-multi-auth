//! Port of `lib/request/helpers/model-map.ts` — the model catalog: alias map,
//! model-id resolution with GPT-5 family fallback, per-model profiles, and
//! tool-surface capability metadata (spec 06 §1).
//!
//! `ModelFamily`, `MODEL_FAMILIES`, `DEFAULT_MODEL` and `DEFAULT_PROBE_MODEL`
//! live in `cma_core::model_family` (de-cycling move #1, ARCHITECTURE §4);
//! this module owns the resolution TABLES and re-exports those names so the
//! TS module surface stays intact for callers.
//!
//! Layering seam: `cma-accounts` (L2) cannot see this crate (L3), so it
//! defined the traits [`cma_accounts::capability_policy::ModelCatalog`] and
//! [`cma_accounts::capability_matrix::ModelProfileProvider`]. The production
//! implementations for both live here on [`RequestModelCatalog`].
//!
//! Resolution contract (spec 06 §1 + gotcha 6):
//! - exact/case-insensitive alias lookup first;
//! - ANY id containing `codex` → [`CURRENT_CODEX_MODEL`];
//! - unknown GPT-5.6 tiers → Sol;
//! - anything else GPT-5-ish → per-minor catalog, defaulting to `gpt-5.5`;
//! - fully unknown ids → [`DEFAULT_MODEL`] (`"gpt-5.5"`).

use std::collections::HashMap;
use std::sync::LazyLock;

use cma_core::constants::{ModelReasoningEffort, WireReasoningEffort};

// TS re-exports: `export { MODEL_FAMILIES, DEFAULT_MODEL, ... }` — the enum
// and default-model constants live in core; the catalog re-exports them.
pub use cma_core::constants::{
    ModelReasoningEffort as ReasoningEffort, WireReasoningEffort as WireEffort,
};
pub use cma_core::model_family::{
    DEFAULT_MODEL, DEFAULT_PROBE_MODEL, MODEL_FAMILIES, ModelFamily, PromptModelFamily,
};

/// TS `ModelCapabilities` — identical shape to the accounts-crate seam type,
/// so the seam type IS the canonical type here (no conversion layer).
pub use cma_accounts::capability_matrix::ModelCapabilitiesInfo as ModelCapabilities;

use cma_accounts::capability_matrix::{MatrixModelProfile, ModelProfileProvider};
use cma_accounts::capability_policy::ModelCatalog;

/// TS `CURRENT_CODEX_MODEL`.
pub const CURRENT_CODEX_MODEL: &str = "gpt-5.3-codex";

const LEGACY_CODEX_MODEL: &str = "gpt-5-codex";

const GPT_5_6_SOL_MODEL: &str = "gpt-5.6-sol";
const GPT_5_6_TERRA_MODEL: &str = "gpt-5.6-terra";
const GPT_5_6_LUNA_MODEL: &str = "gpt-5.6-luna";
/// Bare `gpt-5.6` is OpenAI's documented alias for the flagship (Sol) tier.
const GPT_5_6_FLAGSHIP_ALIAS: &str = "gpt-5.6";

const GPT_5_5_CANONICAL_MODEL: &str = "gpt-5.5";
const GPT_5_5_PRO_CANONICAL_MODEL: &str = "gpt-5.5-pro";
const GPT_5_5_RELEASE_MODEL: &str = "gpt-5.5-2026-04-23";
const GPT_5_5_PRO_RELEASE_MODEL: &str = "gpt-5.5-pro-2026-04-23";
const GPT_5_5_RELEASE_COMPAT_MODEL: &str = "gpt-5.5-20260423";
const GPT_5_5_PRO_RELEASE_COMPAT_MODEL: &str = "gpt-5.5-pro-20260423";

/// Single source of truth for the live/quota probe fallback chain (TS
/// `QUOTA_PROBE_MODEL_CHAIN`). Leads with GPT-5.6 and steps down so accounts
/// without 5.6 entitlement still resolve a working probe model.
pub const QUOTA_PROBE_MODEL_CHAIN: [&str; 6] = [
    DEFAULT_PROBE_MODEL,
    DEFAULT_MODEL,
    "gpt-5.4",
    CURRENT_CODEX_MODEL,
    "gpt-5.2-codex",
    LEGACY_CODEX_MODEL,
];

// ---------------------------------------------------------------------------
// Capability presets (TS `TOOL_CAPABILITIES`)
// ---------------------------------------------------------------------------

const CAPS_FULL: ModelCapabilities = ModelCapabilities {
    tool_search: true,
    computer_use: true,
    compaction: true,
};
/// Defined-but-unused in TS too; kept for table parity.
#[allow(dead_code)]
const CAPS_COMPUTER_ONLY: ModelCapabilities = ModelCapabilities {
    tool_search: false,
    computer_use: true,
    compaction: false,
};
const CAPS_COMPUTER_AND_COMPACT: ModelCapabilities = ModelCapabilities {
    tool_search: false,
    computer_use: true,
    compaction: true,
};
const CAPS_COMPACT_ONLY: ModelCapabilities = ModelCapabilities {
    tool_search: false,
    computer_use: false,
    compaction: true,
};
const CAPS_BASIC: ModelCapabilities = ModelCapabilities {
    tool_search: false,
    computer_use: false,
    compaction: false,
};

// ---------------------------------------------------------------------------
// Model profiles (TS `MODEL_PROFILES`)
// ---------------------------------------------------------------------------

/// TS `ModelProfile`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelProfile {
    pub normalized_model: &'static str,
    pub prompt_family: PromptModelFamily,
    pub default_reasoning_effort: ModelReasoningEffort,
    pub supported_reasoning_efforts: &'static [ModelReasoningEffort],
    pub capabilities: ModelCapabilities,
}

use ModelReasoningEffort as E;

const EFFORTS_CODEX: &[E] = &[E::Low, E::Medium, E::High, E::Xhigh];
const EFFORTS_GENERAL: &[E] = &[E::None, E::Low, E::Medium, E::High, E::Xhigh];
const EFFORTS_PRO: &[E] = &[E::Medium, E::High, E::Xhigh];
const EFFORTS_MEDIUM_ONLY: &[E] = &[E::Medium];
const EFFORTS_GPT_5_1: &[E] = &[E::None, E::Low, E::Medium, E::High];
/// Sol and Terra expose `ultra`; Luna stops at `max`. No 5.6 tier accepts
/// `none`/`minimal`, so those aliases are deliberately never generated.
const GPT_5_6_SOL_TERRA_EFFORTS: &[E] = &[E::Low, E::Medium, E::High, E::Xhigh, E::Max, E::Ultra];
const GPT_5_6_LUNA_EFFORTS: &[E] = &[E::Low, E::Medium, E::High, E::Xhigh, E::Max];

/// Effective model profiles keyed by canonical model name (key ==
/// `normalized_model`), in the exact TS table order — the order is the
/// `ModelProfileProvider::default_models` contract.
pub const MODEL_PROFILES: [ModelProfile; 15] = [
    ModelProfile {
        normalized_model: CURRENT_CODEX_MODEL,
        prompt_family: ModelFamily::Gpt5Codex,
        default_reasoning_effort: E::High,
        supported_reasoning_efforts: EFFORTS_CODEX,
        capabilities: CAPS_BASIC,
    },
    ModelProfile {
        normalized_model: "gpt-5.4",
        prompt_family: ModelFamily::Gpt5_2,
        default_reasoning_effort: E::None,
        supported_reasoning_efforts: EFFORTS_GENERAL,
        capabilities: CAPS_FULL,
    },
    ModelProfile {
        normalized_model: "gpt-5.4-pro",
        prompt_family: ModelFamily::Gpt5_2,
        default_reasoning_effort: E::High,
        supported_reasoning_efforts: EFFORTS_PRO,
        capabilities: CAPS_COMPUTER_AND_COMPACT,
    },
    ModelProfile {
        normalized_model: "gpt-5.4-mini",
        prompt_family: ModelFamily::Gpt5_2,
        default_reasoning_effort: E::Medium,
        supported_reasoning_efforts: EFFORTS_MEDIUM_ONLY,
        capabilities: CAPS_COMPACT_ONLY,
    },
    ModelProfile {
        normalized_model: "gpt-5.4-nano",
        prompt_family: ModelFamily::Gpt5_2,
        default_reasoning_effort: E::Medium,
        supported_reasoning_efforts: EFFORTS_MEDIUM_ONLY,
        capabilities: CAPS_COMPACT_ONLY,
    },
    // GPT-5.6 ships its base instructions inline in the upstream model catalog
    // rather than as a `gpt_5_6_prompt.md`, so these stay on the GPT-5.2
    // prompt family alongside the other post-5.2 general models.
    ModelProfile {
        normalized_model: GPT_5_6_SOL_MODEL,
        prompt_family: ModelFamily::Gpt5_2,
        default_reasoning_effort: E::Low,
        supported_reasoning_efforts: GPT_5_6_SOL_TERRA_EFFORTS,
        capabilities: CAPS_FULL,
    },
    ModelProfile {
        normalized_model: GPT_5_6_TERRA_MODEL,
        prompt_family: ModelFamily::Gpt5_2,
        default_reasoning_effort: E::Medium,
        supported_reasoning_efforts: GPT_5_6_SOL_TERRA_EFFORTS,
        capabilities: CAPS_FULL,
    },
    ModelProfile {
        normalized_model: GPT_5_6_LUNA_MODEL,
        prompt_family: ModelFamily::Gpt5_2,
        default_reasoning_effort: E::Medium,
        supported_reasoning_efforts: GPT_5_6_LUNA_EFFORTS,
        capabilities: CAPS_FULL,
    },
    ModelProfile {
        normalized_model: GPT_5_5_CANONICAL_MODEL,
        prompt_family: ModelFamily::Gpt5_2,
        default_reasoning_effort: E::None,
        supported_reasoning_efforts: EFFORTS_GENERAL,
        capabilities: CAPS_FULL,
    },
    ModelProfile {
        normalized_model: GPT_5_5_PRO_CANONICAL_MODEL,
        prompt_family: ModelFamily::Gpt5_2,
        default_reasoning_effort: E::High,
        supported_reasoning_efforts: EFFORTS_PRO,
        capabilities: CAPS_COMPUTER_AND_COMPACT,
    },
    ModelProfile {
        normalized_model: "gpt-5.2-pro",
        prompt_family: ModelFamily::Gpt5_2,
        default_reasoning_effort: E::High,
        supported_reasoning_efforts: EFFORTS_PRO,
        capabilities: CAPS_BASIC,
    },
    ModelProfile {
        normalized_model: "gpt-5.2",
        prompt_family: ModelFamily::Gpt5_2,
        default_reasoning_effort: E::None,
        supported_reasoning_efforts: EFFORTS_GENERAL,
        capabilities: CAPS_BASIC,
    },
    ModelProfile {
        normalized_model: "gpt-5.1",
        prompt_family: ModelFamily::Gpt5_1,
        default_reasoning_effort: E::None,
        supported_reasoning_efforts: EFFORTS_GPT_5_1,
        capabilities: CAPS_BASIC,
    },
    ModelProfile {
        normalized_model: "gpt-5-mini",
        prompt_family: ModelFamily::Gpt5_2,
        default_reasoning_effort: E::Medium,
        supported_reasoning_efforts: EFFORTS_MEDIUM_ONLY,
        capabilities: CAPS_COMPACT_ONLY,
    },
    ModelProfile {
        normalized_model: "gpt-5-nano",
        prompt_family: ModelFamily::Gpt5_2,
        default_reasoning_effort: E::Medium,
        supported_reasoning_efforts: EFFORTS_MEDIUM_ONLY,
        capabilities: CAPS_COMPACT_ONLY,
    },
];

/// `MODEL_PROFILES[model]` — exact-key lookup (key == `normalized_model`).
pub fn get_model_profile_exact(model: &str) -> Option<&'static ModelProfile> {
    MODEL_PROFILES
        .iter()
        .find(|profile| profile.normalized_model == model)
}

// ---------------------------------------------------------------------------
// Alias map (TS `MODEL_MAP`)
// ---------------------------------------------------------------------------

/// Insertion-ordered alias → canonical-model map reproducing JS object
/// property-order semantics: re-inserting an existing key updates its value
/// but keeps its original position (matters for the case-insensitive
/// first-match scan in [`ModelMap::get_case_insensitive`]).
#[derive(Debug, Default)]
pub struct ModelMap {
    entries: Vec<(String, &'static str)>,
    index: HashMap<String, usize>,
}

impl ModelMap {
    fn insert(&mut self, alias: &str, canonical: &'static str) {
        if let Some(&position) = self.index.get(alias) {
            self.entries[position].1 = canonical;
        } else {
            self.index.insert(alias.to_string(), self.entries.len());
            self.entries.push((alias.to_string(), canonical));
        }
    }

    /// Exact-key lookup (TS `Object.hasOwn(MODEL_MAP, id)` + read).
    pub fn get(&self, alias: &str) -> Option<&'static str> {
        self.index.get(alias).map(|&position| self.entries[position].1)
    }

    /// First key (in insertion order) whose lowercase form equals the
    /// lowercased id (TS `Object.keys(MODEL_MAP).find(...)`).
    pub fn get_case_insensitive(&self, alias: &str) -> Option<&'static str> {
        let lower = alias.to_lowercase();
        self.entries
            .iter()
            .find(|(key, _)| key.to_lowercase() == lower)
            .map(|&(_, canonical)| canonical)
    }

    /// Aliases in insertion order.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(key, _)| key.as_str())
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// The alias map (TS `MODEL_MAP`), built once at first use in the exact TS
/// registration order.
pub fn model_map() -> &'static ModelMap {
    &MODEL_MAP
}

static MODEL_MAP: LazyLock<ModelMap> = LazyLock::new(build_model_map);

/// TS `REASONING_VARIANTS` — the alias-suffix set (NOT max/ultra).
const REASONING_VARIANTS: [&str; 6] = ["none", "minimal", "low", "medium", "high", "xhigh"];

fn add_alias(map: &mut ModelMap, alias: &str, normalized_model: &'static str) {
    map.insert(alias, normalized_model);
}

fn add_reasoning_aliases(map: &mut ModelMap, alias: &str, normalized_model: &'static str) {
    add_alias(map, alias, normalized_model);
    for variant in REASONING_VARIANTS {
        add_alias(map, &format!("{alias}-{variant}"), normalized_model);
    }
}

/// Register a model plus one alias per effort it actually supports.
///
/// Unlike [`add_reasoning_aliases`], this does not assume the global variant
/// list: GPT-5.6 rejects `none`/`minimal` and only Sol/Terra accept `ultra`.
fn add_effort_aliases(
    map: &mut ModelMap,
    alias: &str,
    normalized_model: &'static str,
    efforts: &[ModelReasoningEffort],
) {
    add_alias(map, alias, normalized_model);
    for effort in efforts {
        add_alias(map, &format!("{alias}-{}", effort.as_str()), normalized_model);
    }
}

fn add_codex_aliases(map: &mut ModelMap) {
    add_reasoning_aliases(map, CURRENT_CODEX_MODEL, CURRENT_CODEX_MODEL);
    add_reasoning_aliases(map, "gpt-5.3-codex-spark", CURRENT_CODEX_MODEL);
    add_reasoning_aliases(map, LEGACY_CODEX_MODEL, CURRENT_CODEX_MODEL);
    add_reasoning_aliases(map, "gpt-5.2-codex", CURRENT_CODEX_MODEL);
    add_reasoning_aliases(map, "gpt-5.1-codex", CURRENT_CODEX_MODEL);
    add_alias(map, "gpt_5_codex", CURRENT_CODEX_MODEL);

    add_reasoning_aliases(map, "codex-max", CURRENT_CODEX_MODEL);
    add_reasoning_aliases(map, "gpt-5.1-codex-max", CURRENT_CODEX_MODEL);
    // TS registers the bare `codex-max` alias a second time (harmless
    // overwrite; position preserved).
    add_alias(map, "codex-max", CURRENT_CODEX_MODEL);

    add_alias(map, "codex-mini-latest", CURRENT_CODEX_MODEL);
    add_reasoning_aliases(map, "gpt-5-codex-mini", CURRENT_CODEX_MODEL);
    add_reasoning_aliases(map, "gpt-5.1-codex-mini", CURRENT_CODEX_MODEL);
}

fn add_general_aliases(map: &mut ModelMap) {
    add_reasoning_aliases(map, GPT_5_5_CANONICAL_MODEL, GPT_5_5_CANONICAL_MODEL);
    add_reasoning_aliases(map, GPT_5_5_RELEASE_MODEL, GPT_5_5_CANONICAL_MODEL);
    add_reasoning_aliases(map, GPT_5_5_RELEASE_COMPAT_MODEL, GPT_5_5_CANONICAL_MODEL);
    add_reasoning_aliases(map, GPT_5_5_PRO_CANONICAL_MODEL, GPT_5_5_PRO_CANONICAL_MODEL);
    add_reasoning_aliases(map, GPT_5_5_PRO_RELEASE_MODEL, GPT_5_5_PRO_CANONICAL_MODEL);
    add_reasoning_aliases(map, GPT_5_5_PRO_RELEASE_COMPAT_MODEL, GPT_5_5_PRO_CANONICAL_MODEL);
    add_reasoning_aliases(map, "gpt-5.4", "gpt-5.4");
    add_reasoning_aliases(map, "gpt-5.4-pro", "gpt-5.4-pro");
    add_reasoning_aliases(map, "gpt-5.4-mini", "gpt-5.4-mini");
    add_reasoning_aliases(map, "gpt-5.4-nano", "gpt-5.4-nano");
    add_reasoning_aliases(map, "gpt-5.2-pro", "gpt-5.2-pro");
    add_reasoning_aliases(map, "gpt-5-pro", GPT_5_5_PRO_CANONICAL_MODEL);
    add_reasoning_aliases(map, "gpt-5.2", "gpt-5.2");
    add_reasoning_aliases(map, "gpt-5.1", "gpt-5.1");
    add_reasoning_aliases(map, "gpt-5", DEFAULT_MODEL);
    add_reasoning_aliases(map, "gpt-5-mini", "gpt-5-mini");
    add_reasoning_aliases(map, "gpt-5-nano", "gpt-5-nano");

    add_reasoning_aliases(map, "gpt-5.1-chat-latest", "gpt-5.1");
    add_reasoning_aliases(map, "gpt-5-chat-latest", DEFAULT_MODEL);
}

fn add_gpt56_aliases(map: &mut ModelMap) {
    add_effort_aliases(map, GPT_5_6_SOL_MODEL, GPT_5_6_SOL_MODEL, GPT_5_6_SOL_TERRA_EFFORTS);
    add_effort_aliases(
        map,
        GPT_5_6_TERRA_MODEL,
        GPT_5_6_TERRA_MODEL,
        GPT_5_6_SOL_TERRA_EFFORTS,
    );
    add_effort_aliases(map, GPT_5_6_LUNA_MODEL, GPT_5_6_LUNA_MODEL, GPT_5_6_LUNA_EFFORTS);
    add_effort_aliases(
        map,
        GPT_5_6_FLAGSHIP_ALIAS,
        GPT_5_6_SOL_MODEL,
        GPT_5_6_SOL_TERRA_EFFORTS,
    );
}

fn build_model_map() -> ModelMap {
    let mut map = ModelMap::default();
    add_codex_aliases(&mut map);
    add_general_aliases(&mut map);
    add_gpt56_aliases(&mut map);
    map
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/// TS `stripProviderPrefix` — everything after the last `/` (a trailing `/`
/// therefore strips to the empty string, exactly like `split("/").pop()`).
pub(crate) fn strip_provider_prefix(model_id: &str) -> &str {
    if model_id.contains('/') {
        model_id.rsplit('/').next().unwrap_or(model_id)
    } else {
        model_id
    }
}

/// TS `tokenizeModelId` — lowercase, split on runs of `[^a-z0-9]`.
fn tokenize_model_id(model_id: &str) -> Vec<String> {
    model_id
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .collect()
}

/// TS `lookupMappedModel` — exact, then first case-insensitive key match in
/// insertion order.
fn lookup_mapped_model(model_id: &str) -> Option<&'static str> {
    let map = model_map();
    if let Some(canonical) = map.get(model_id) {
        return Some(canonical);
    }
    map.get_case_insensitive(model_id)
}

/// TS `resolveCodexCatalogModel`.
///
/// The TS body is a chain of lowercase substring checks
/// (`gpt-5.3-codex[-spark]`, `gpt 5.3 codex`, `gpt-5.2-codex`, …,
/// plain `codex`) that ALL return [`CURRENT_CODEX_MODEL`]; since every needle
/// contains `codex` and the final check is plain `codex`, the chain reduces to
/// "anything containing `codex`" (spec 06 §1 step 4 states this explicitly).
fn resolve_codex_catalog_model(model_id: &str) -> Option<&'static str> {
    if model_id.to_lowercase().contains("codex") {
        Some(CURRENT_CODEX_MODEL)
    } else {
        None
    }
}

/// TS `resolveGpt56CatalogModel` — resolves GPT-5.6 identifiers that are not
/// exact aliases (for example a future `gpt-5.6-terra-fast`). Unrecognised
/// tiers resolve to Sol, matching OpenAI's bare `gpt-5.6` alias. Without this,
/// the general resolver would silently fall back to 5.5.
fn resolve_gpt56_catalog_model(model_id: &str) -> Option<&'static str> {
    let tokens = tokenize_model_id(model_id);
    let gpt_index = tokens.iter().position(|token| token == "gpt")?;
    let is_gpt56 = tokens.get(gpt_index + 1).map(String::as_str) == Some("5")
        && tokens.get(gpt_index + 2).map(String::as_str) == Some("6");
    if !is_gpt56 || tokens.iter().any(|token| token == "codex") {
        return None;
    }

    if tokens.iter().any(|token| token == "terra") {
        return Some(GPT_5_6_TERRA_MODEL);
    }
    if tokens.iter().any(|token| token == "luna") {
        return Some(GPT_5_6_LUNA_MODEL);
    }
    Some(GPT_5_6_SOL_MODEL)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GeneralGpt5Variant {
    Base,
    Pro,
    Mini,
    Nano,
}

#[derive(Debug, Clone, Copy)]
struct GeneralGpt5VariantCatalog {
    base: &'static str,
    pro: Option<&'static str>,
    mini: Option<&'static str>,
    nano: Option<&'static str>,
}

impl GeneralGpt5VariantCatalog {
    /// TS `resolveGeneralGpt5CatalogVariant` — `catalog[variant] ?? catalog.base`.
    fn resolve(self, variant: GeneralGpt5Variant) -> &'static str {
        match variant {
            GeneralGpt5Variant::Base => self.base,
            GeneralGpt5Variant::Pro => self.pro.unwrap_or(self.base),
            GeneralGpt5Variant::Mini => self.mini.unwrap_or(self.base),
            GeneralGpt5Variant::Nano => self.nano.unwrap_or(self.base),
        }
    }
}

/// TS `GENERAL_GPT5_VERSION_CATALOG` — per-minor variant tables. Note the
/// deliberate `4.base = DEFAULT_MODEL` ("gpt-5.5", not "gpt-5.4"): `gpt-5.4`
/// itself resolves through the exact alias map; this entry only matters for
/// odd spellings like `gpt 5 4` that miss the alias map.
fn general_gpt5_catalog_for_minor(minor: u64) -> Option<GeneralGpt5VariantCatalog> {
    match minor {
        1 => Some(GeneralGpt5VariantCatalog {
            base: "gpt-5.1",
            pro: None,
            mini: None,
            nano: None,
        }),
        2 => Some(GeneralGpt5VariantCatalog {
            base: "gpt-5.2",
            pro: Some("gpt-5.2-pro"),
            mini: None,
            nano: None,
        }),
        4 => Some(GeneralGpt5VariantCatalog {
            base: DEFAULT_MODEL,
            pro: Some("gpt-5.4-pro"),
            mini: Some("gpt-5.4-mini"),
            nano: Some("gpt-5.4-nano"),
        }),
        5 => Some(GENERAL_GPT5_STABLE_VARIANTS),
        _ => None,
    }
}

/// TS `GENERAL_GPT5_STABLE_VARIANTS` (`GENERAL_GPT5_VERSION_CATALOG[5]`).
const GENERAL_GPT5_STABLE_VARIANTS: GeneralGpt5VariantCatalog = GeneralGpt5VariantCatalog {
    base: GPT_5_5_CANONICAL_MODEL,
    pro: Some(GPT_5_5_PRO_CANONICAL_MODEL),
    mini: Some("gpt-5-mini"),
    nano: Some("gpt-5-nano"),
};

/// TS `GENERAL_GPT5_GENERIC_VARIANTS` (no minor version present).
const GENERAL_GPT5_GENERIC_VARIANTS: GeneralGpt5VariantCatalog = GeneralGpt5VariantCatalog {
    base: DEFAULT_MODEL,
    pro: Some(GPT_5_5_PRO_CANONICAL_MODEL),
    mini: Some("gpt-5-mini"),
    nano: Some("gpt-5-nano"),
};

/// TS `resolveGeneralGpt5CatalogModel`.
fn resolve_general_gpt5_catalog_model(model_id: &str) -> Option<&'static str> {
    let tokens = tokenize_model_id(model_id);
    let gpt_index = tokens.iter().position(|token| token == "gpt")?;
    if tokens.get(gpt_index + 1).map(String::as_str) != Some("5") {
        return None;
    }
    if tokens.iter().any(|token| token == "codex") {
        return None;
    }

    // `/^\d+$/` on the token after `5`; unparseable-but-numeric (overflow)
    // behaves like an unknown minor, which resolves through the stable
    // catalog exactly as a huge JS Number would.
    let raw_minor = tokens.get(gpt_index + 2);
    let is_numeric_minor = raw_minor
        .map(|token| !token.is_empty() && token.bytes().all(|b| b.is_ascii_digit()))
        .unwrap_or(false);

    let variant = if tokens.iter().any(|token| token == "mini") {
        GeneralGpt5Variant::Mini
    } else if tokens.iter().any(|token| token == "nano") {
        GeneralGpt5Variant::Nano
    } else if tokens.iter().any(|token| token == "pro") {
        GeneralGpt5Variant::Pro
    } else {
        GeneralGpt5Variant::Base
    };

    if !is_numeric_minor {
        return Some(GENERAL_GPT5_GENERIC_VARIANTS.resolve(variant));
    }

    let known_catalog = raw_minor
        .and_then(|token| token.parse::<u64>().ok())
        .and_then(general_gpt5_catalog_for_minor);
    match known_catalog {
        Some(catalog) => Some(catalog.resolve(variant)),
        // Unknown minor → stable (v5) catalog for the variant.
        None => Some(GENERAL_GPT5_STABLE_VARIANTS.resolve(variant)),
    }
}

/// TS `getNormalizedModel` — exact/case-insensitive alias lookup ONLY
/// (strips provider prefix, trims); `None` for unknown ids; never panics.
pub fn get_normalized_model(model_id: &str) -> Option<&'static str> {
    let stripped = strip_provider_prefix(model_id.trim());
    if stripped.is_empty() {
        return None;
    }
    lookup_mapped_model(stripped)
}

/// TS `resolveNormalizedModel` — alias lookup expanded with the GPT-5 family
/// fallback rules; empty/`None` → [`DEFAULT_MODEL`].
pub fn resolve_normalized_model(model: Option<&str>) -> &'static str {
    let Some(model) = model else {
        return DEFAULT_MODEL;
    };
    if model.is_empty() {
        return DEFAULT_MODEL;
    }

    let model_id = strip_provider_prefix(model).trim();
    if model_id.is_empty() {
        return DEFAULT_MODEL;
    }

    if let Some(mapped) = lookup_mapped_model(model_id) {
        return mapped;
    }
    if let Some(codex) = resolve_codex_catalog_model(model_id) {
        return codex;
    }
    if let Some(gpt56) = resolve_gpt56_catalog_model(model_id) {
        return gpt56;
    }
    if let Some(general) = resolve_general_gpt5_catalog_model(model_id) {
        return general;
    }

    DEFAULT_MODEL
}

/// TS `getModelProfile` — profile of the resolved model, falling back to the
/// [`DEFAULT_MODEL`] profile (which the static table guarantees exists).
pub fn get_model_profile(model: Option<&str>) -> &'static ModelProfile {
    let normalized = resolve_normalized_model(model);
    get_model_profile_exact(normalized)
        .or_else(|| get_model_profile_exact(DEFAULT_MODEL))
        .unwrap_or_else(|| panic!("Default model profile is missing for {DEFAULT_MODEL}"))
}

/// TS `getModelCapabilities`.
pub fn get_model_capabilities(model: Option<&str>) -> ModelCapabilities {
    get_model_profile(model).capabilities
}

/// TS `getModelFamily` (source: `lib/prompts/codex.ts`; the table row for
/// this module assigns it here) — the prompt family of the resolved model.
pub fn get_model_family(model: &str) -> PromptModelFamily {
    get_model_profile(Some(model)).prompt_family
}

/// Cheapest-first ordering used to pick a quota-probe reasoning effort.
/// `ultra` is intentionally absent: it never reaches the wire (upstream
/// rewrites it to `max`) and would only ever be a more expensive choice.
const PROBE_REASONING_EFFORT_PREFERENCE: [WireReasoningEffort; 7] = [
    WireReasoningEffort::None,
    WireReasoningEffort::Minimal,
    WireReasoningEffort::Low,
    WireReasoningEffort::Medium,
    WireReasoningEffort::High,
    WireReasoningEffort::Xhigh,
    WireReasoningEffort::Max,
];

/// TS `resolveProbeReasoningEffort` — the cheapest effort the probe model
/// declares support for; fallback is the profile default with `ultra` → `max`.
/// Never returns `ultra` (the type makes that structural).
pub fn resolve_probe_reasoning_effort(model: Option<&str>) -> WireReasoningEffort {
    let profile = get_model_profile(model);
    for wire in PROBE_REASONING_EFFORT_PREFERENCE {
        if profile
            .supported_reasoning_efforts
            .contains(&ModelReasoningEffort::from(wire))
        {
            return wire;
        }
    }
    profile.default_reasoning_effort.to_wire()
}

/// TS `isKnownModel` — `true` only for exact known aliases (no fallback).
pub fn is_known_model(model_id: &str) -> bool {
    get_normalized_model(model_id).is_some()
}

// ---------------------------------------------------------------------------
// L2 seam implementations (cma-accounts traits)
// ---------------------------------------------------------------------------

/// Production implementation of the accounts-crate catalog seams, backed by
/// this module's tables. Wire it into
/// `cma_accounts::capability_policy::CapabilityPolicyStore::with_catalog` and
/// `cma_accounts::capability_matrix::build_model_capability_matrix`.
#[derive(Debug, Clone, Copy, Default)]
pub struct RequestModelCatalog;

impl ModelCatalog for RequestModelCatalog {
    fn get_normalized_model(&self, model: &str) -> Option<String> {
        get_normalized_model(model).map(str::to_string)
    }

    fn resolve_normalized_model(&self, model: &str) -> String {
        resolve_normalized_model(Some(model)).to_string()
    }
}

impl ModelProfileProvider for RequestModelCatalog {
    fn default_models(&self) -> Vec<String> {
        MODEL_PROFILES
            .iter()
            .map(|profile| profile.normalized_model.to_string())
            .collect()
    }

    fn resolve_normalized_model(&self, model: &str) -> String {
        resolve_normalized_model(Some(model)).to_string()
    }

    fn profile(&self, model: &str) -> Option<MatrixModelProfile> {
        get_model_profile_exact(model).map(|profile| MatrixModelProfile {
            normalized_model: profile.normalized_model.to_string(),
            prompt_family: profile.prompt_family,
            default_reasoning_effort: profile.default_reasoning_effort,
            supported_reasoning_efforts: profile.supported_reasoning_efforts.to_vec(),
            capabilities: profile.capabilities,
        })
    }
}

/// Shared handle for call sites that take `Arc<dyn ModelCatalog>`.
pub fn shared_model_catalog() -> std::sync::Arc<dyn ModelCatalog> {
    std::sync::Arc::new(RequestModelCatalog)
}

// ===========================================================================
// Tests — ported from test/model-map.test.ts (+ Rust-only table/seam checks)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // --- MODEL_MAP -------------------------------------------------------

    #[test]
    fn routes_codex_aliases_to_the_current_documented_codex_model() {
        let map = model_map();
        assert_eq!(map.get("gpt-5-codex"), Some("gpt-5.3-codex"));
        assert_eq!(map.get("gpt-5.3-codex-spark-high"), Some("gpt-5.3-codex"));
        assert_eq!(map.get("gpt-5.1-codex-max-xhigh"), Some("gpt-5.3-codex"));
        assert_eq!(map.get("codex-mini-latest"), Some("gpt-5.3-codex"));
        assert_eq!(map.get("gpt_5_codex"), Some("gpt-5.3-codex"));
        assert_eq!(map.get("codex-max"), Some("gpt-5.3-codex"));
    }

    #[test]
    fn keeps_gpt_5_5_aliases_canonical_while_preserving_existing_general_models() {
        let map = model_map();
        assert_eq!(map.get("gpt-5.5"), Some("gpt-5.5"));
        assert_eq!(map.get("gpt-5.5-pro-high"), Some("gpt-5.5-pro"));
        assert_eq!(map.get("gpt-5.4"), Some("gpt-5.4"));
        assert_eq!(map.get("gpt-5"), Some("gpt-5.5"));
    }

    #[test]
    fn keeps_mini_and_nano_on_current_non_5_1_model_ids() {
        let map = model_map();
        assert_eq!(map.get("gpt-5-mini"), Some("gpt-5-mini"));
        assert_eq!(map.get("gpt-5-nano"), Some("gpt-5-nano"));
        assert_eq!(map.get("gpt-5.4-mini"), Some("gpt-5.4-mini"));
        assert_eq!(map.get("gpt-5.4-nano"), Some("gpt-5.4-nano"));
    }

    #[test]
    fn adds_reasoning_variants_for_legacy_chat_latest_aliases() {
        let map = model_map();
        assert_eq!(map.get("gpt-5-chat-latest-high"), Some("gpt-5.5"));
        assert_eq!(map.get("gpt-5.1-chat-latest-minimal"), Some("gpt-5.1"));
    }

    #[test]
    fn gpt56_aliases_use_per_tier_effort_lists_not_the_global_variant_list() {
        let map = model_map();
        // Sol/Terra list ultra; Luna stops at max.
        assert_eq!(map.get("gpt-5.6-sol-ultra"), Some("gpt-5.6-sol"));
        assert_eq!(map.get("gpt-5.6-terra-ultra"), Some("gpt-5.6-terra"));
        assert_eq!(map.get("gpt-5.6-luna-max"), Some("gpt-5.6-luna"));
        assert_eq!(map.get("gpt-5.6-luna-ultra"), None);
        // No 5.6 tier registers none/minimal aliases.
        assert_eq!(map.get("gpt-5.6-sol-none"), None);
        assert_eq!(map.get("gpt-5.6-terra-minimal"), None);
        // Bare flagship alias (+ effort variants) lands on Sol.
        assert_eq!(map.get("gpt-5.6"), Some("gpt-5.6-sol"));
        assert_eq!(map.get("gpt-5.6-max"), Some("gpt-5.6-sol"));
    }

    #[test]
    fn reinserting_an_alias_keeps_its_original_position() {
        let mut map = ModelMap::default();
        map.insert("a", "one");
        map.insert("b", "two");
        map.insert("a", "three");
        let keys: Vec<&str> = map.keys().collect();
        assert_eq!(keys, vec!["a", "b"]);
        assert_eq!(map.get("a"), Some("three"));
        assert_eq!(map.len(), 2);
        assert!(!map.is_empty());
    }

    // --- getNormalizedModel ----------------------------------------------

    #[test]
    fn returns_exact_aliases_case_insensitively() {
        assert_eq!(get_normalized_model("GPT-5.5"), Some("gpt-5.5"));
        assert_eq!(get_normalized_model("GPT-5.5-PRO-HIGH"), Some("gpt-5.5-pro"));
        assert_eq!(get_normalized_model("GPT-5.4"), Some("gpt-5.4"));
        assert_eq!(get_normalized_model("GPT-5.4-PRO-HIGH"), Some("gpt-5.4-pro"));
        assert_eq!(get_normalized_model("gpt-5.4-mini"), Some("gpt-5.4-mini"));
        assert_eq!(get_normalized_model("gpt-5.3-codex-high"), Some("gpt-5.3-codex"));
        assert_eq!(get_normalized_model("gpt-5-chat-latest-high"), Some("gpt-5.5"));
        assert_eq!(get_normalized_model("codex-max"), Some("gpt-5.3-codex"));
    }

    #[test]
    fn returns_none_for_unknown_exact_identifiers() {
        assert_eq!(get_normalized_model("unknown-model"), None);
        assert_eq!(get_normalized_model("gpt-6"), None);
        assert_eq!(get_normalized_model("gpt-5.7"), None);
        assert_eq!(get_normalized_model(""), None);
        // Trailing provider slash strips to empty → None.
        assert_eq!(get_normalized_model("openai/"), None);
    }

    // --- resolveNormalizedModel ------------------------------------------

    #[test]
    fn resolves_provider_prefixed_and_verbose_gpt5_variants() {
        assert_eq!(
            resolve_normalized_model(Some("openai/gpt-5.5-2026-04-23")),
            "gpt-5.5"
        );
        assert_eq!(
            resolve_normalized_model(Some("openai/gpt-5.5-20260423")),
            "gpt-5.5"
        );
        assert_eq!(resolve_normalized_model(Some("GPT 5.5 Pro High")), "gpt-5.5-pro");
        assert_eq!(resolve_normalized_model(Some("openai/gpt-5.4")), "gpt-5.4");
        assert_eq!(
            resolve_normalized_model(Some("openai/gpt-5.4-mini-high")),
            "gpt-5.4-mini"
        );
        assert_eq!(resolve_normalized_model(Some("GPT 5.4 Pro High")), "gpt-5.4-pro");
        assert_eq!(
            resolve_normalized_model(Some("GPT 5 Codex Low (ChatGPT Subscription)")),
            "gpt-5.3-codex"
        );
    }

    #[test]
    fn defaults_unknown_gpt5ish_requests_to_gpt_5_5_instead_of_gpt_5_1() {
        assert_eq!(resolve_normalized_model(Some("gpt-5-unknown-preview")), "gpt-5.5");
        assert_eq!(
            resolve_normalized_model(Some("gpt 5 experimental build")),
            "gpt-5.5"
        );
    }

    #[test]
    fn keeps_gpt_5_5_aliases_first_class_with_fallback_routing_for_unknown_names() {
        assert_eq!(resolve_normalized_model(Some("gpt-5.5")), "gpt-5.5");
        assert_eq!(resolve_normalized_model(Some("gpt-5.5-high")), "gpt-5.5");
        assert_eq!(
            resolve_normalized_model(Some("openai/gpt-5.5-pro-high")),
            "gpt-5.5-pro"
        );
    }

    #[test]
    fn uses_the_current_default_model_when_the_request_is_missing_or_unrelated() {
        assert_eq!(resolve_normalized_model(None), DEFAULT_MODEL);
        assert_eq!(resolve_normalized_model(Some("")), DEFAULT_MODEL);
        assert_eq!(resolve_normalized_model(Some("gpt-4")), DEFAULT_MODEL);
        assert_eq!(resolve_normalized_model(Some("unknown-model")), DEFAULT_MODEL);
    }

    #[test]
    fn anything_containing_codex_normalizes_to_the_current_codex_model() {
        assert_eq!(resolve_normalized_model(Some("my-gpt-5-codex-model")), "gpt-5.3-codex");
        assert_eq!(resolve_normalized_model(Some("mycodex")), "gpt-5.3-codex");
        assert_eq!(resolve_normalized_model(Some("gpt 5.2 codex")), "gpt-5.3-codex");
        assert_eq!(
            resolve_normalized_model(Some("gpt 5.1 codex max")),
            "gpt-5.3-codex"
        );
    }

    #[test]
    fn unknown_gpt56_tiers_land_on_sol_and_named_tiers_resolve() {
        // Not exact aliases → the 5.6 token resolver.
        assert_eq!(
            resolve_normalized_model(Some("gpt-5.6-terra-fast")),
            "gpt-5.6-terra"
        );
        assert_eq!(
            resolve_normalized_model(Some("gpt 5.6 luna preview")),
            "gpt-5.6-luna"
        );
        assert_eq!(resolve_normalized_model(Some("gpt-5.6-pro")), "gpt-5.6-sol");
        assert_eq!(resolve_normalized_model(Some("GPT 5 6")), "gpt-5.6-sol");
        // 5.6 + codex → the codex resolver wins first.
        assert_eq!(
            resolve_normalized_model(Some("gpt-5.6-codex")),
            "gpt-5.3-codex"
        );
    }

    #[test]
    fn general_gpt5_catalog_resolves_minor_and_variant_tokens() {
        // Minor-version catalogs.
        assert_eq!(resolve_normalized_model(Some("gpt 5 1")), "gpt-5.1");
        assert_eq!(resolve_normalized_model(Some("gpt 5 2 pro")), "gpt-5.2-pro");
        // Minor-1 catalog has base only → pro falls back to base.
        assert_eq!(resolve_normalized_model(Some("gpt 5 1 pro")), "gpt-5.1");
        // Minor-4 base is literally DEFAULT_MODEL (gpt-5.5) — deliberate.
        assert_eq!(resolve_normalized_model(Some("gpt 5 4")), "gpt-5.5");
        assert_eq!(resolve_normalized_model(Some("gpt 5 4 mini")), "gpt-5.4-mini");
        // Unknown minor → stable (v5) catalog.
        assert_eq!(resolve_normalized_model(Some("gpt 5 7 pro")), "gpt-5.5-pro");
        assert_eq!(resolve_normalized_model(Some("gpt-5.7")), "gpt-5.5");
        // Variant precedence: mini beats nano beats pro.
        assert_eq!(
            resolve_normalized_model(Some("gpt 5 pro mini nano")),
            "gpt-5-mini"
        );
    }

    // --- model profiles ---------------------------------------------------

    #[test]
    fn routes_gpt_5_4_era_general_models_through_the_latest_general_prompt_family() {
        assert_eq!(
            get_model_profile(Some("gpt-5.4")).prompt_family,
            ModelFamily::Gpt5_2
        );
        assert_eq!(
            get_model_profile(Some("gpt-5.4-pro")).prompt_family,
            ModelFamily::Gpt5_2
        );
        assert_eq!(
            get_model_profile(Some("gpt-5-mini")).prompt_family,
            ModelFamily::Gpt5_2
        );
    }

    #[test]
    fn keeps_gpt_5_1_on_its_own_prompt_family() {
        assert_eq!(
            get_model_profile(Some("gpt-5.1")).prompt_family,
            ModelFamily::Gpt5_1
        );
        assert_eq!(get_model_family("gpt-5.1"), ModelFamily::Gpt5_1);
        assert_eq!(get_model_family("gpt-5-codex"), ModelFamily::Gpt5Codex);
    }

    #[test]
    fn exposes_tool_search_and_computer_use_capabilities() {
        let full = ModelCapabilities {
            tool_search: true,
            computer_use: true,
            compaction: true,
        };
        let computer_and_compact = ModelCapabilities {
            tool_search: false,
            computer_use: true,
            compaction: true,
        };
        let compact_only = ModelCapabilities {
            tool_search: false,
            computer_use: false,
            compaction: true,
        };
        assert_eq!(get_model_capabilities(Some("gpt-5.5")), full);
        assert_eq!(get_model_capabilities(Some("gpt-5.5-pro")), computer_and_compact);
        assert_eq!(get_model_capabilities(Some("gpt-5.4")), full);
        assert_eq!(get_model_capabilities(Some("gpt-5.4-pro")), computer_and_compact);
        assert_eq!(get_model_capabilities(Some("gpt-5.4-mini")), compact_only);
        assert_eq!(get_model_capabilities(Some("gpt-5-mini")), compact_only);
        assert_eq!(get_model_capabilities(Some("gpt-5-nano")), compact_only);
    }

    #[test]
    fn unknown_models_fall_back_to_the_default_profile() {
        let profile = get_model_profile(Some("claude-3"));
        assert_eq!(profile.normalized_model, DEFAULT_MODEL);
        assert_eq!(get_model_profile(None).normalized_model, DEFAULT_MODEL);
    }

    // --- isKnownModel -----------------------------------------------------

    #[test]
    fn is_known_model_returns_true_for_explicit_aliases_only() {
        assert!(is_known_model("gpt-5.5"));
        assert!(is_known_model("gpt-5.5-pro-2026-04-23"));
        assert!(is_known_model("gpt-5.5-pro-20260423"));
        assert!(is_known_model("gpt-5.4"));
        assert!(is_known_model("gpt-5.4-mini"));
        assert!(is_known_model("GPT-5.3-CODEX-HIGH"));

        assert!(!is_known_model("gpt-5-unknown-preview"));
        assert!(!is_known_model("gpt-5.6-pro"));
        assert!(!is_known_model("claude-3"));
        assert!(!is_known_model(""));
    }

    // --- probe helpers ----------------------------------------------------

    #[test]
    fn quota_probe_model_chain_matches_ts() {
        assert_eq!(
            QUOTA_PROBE_MODEL_CHAIN,
            [
                "gpt-5.6-sol",
                "gpt-5.5",
                "gpt-5.4",
                "gpt-5.3-codex",
                "gpt-5.2-codex",
                "gpt-5-codex",
            ]
        );
    }

    #[test]
    fn resolve_probe_reasoning_effort_picks_the_cheapest_supported_wire_effort() {
        // Pre-5.6 general models that list `none` send `none`.
        assert_eq!(
            resolve_probe_reasoning_effort(Some("gpt-5.5")),
            WireReasoningEffort::None
        );
        // Codex and GPT-5.6 tiers do not list none/minimal → `low`.
        assert_eq!(
            resolve_probe_reasoning_effort(Some("gpt-5.3-codex")),
            WireReasoningEffort::Low
        );
        assert_eq!(
            resolve_probe_reasoning_effort(Some("gpt-5.6-sol")),
            WireReasoningEffort::Low
        );
        // Medium-only smalls send medium; pro tiers send medium.
        assert_eq!(
            resolve_probe_reasoning_effort(Some("gpt-5-nano")),
            WireReasoningEffort::Medium
        );
        assert_eq!(
            resolve_probe_reasoning_effort(Some("gpt-5.5-pro")),
            WireReasoningEffort::Medium
        );
    }

    // --- L2 seam impls ----------------------------------------------------

    #[test]
    fn model_catalog_seam_matches_the_free_functions() {
        let catalog = RequestModelCatalog;
        assert_eq!(
            ModelCatalog::get_normalized_model(&catalog, "GPT-5.5-PRO-HIGH"),
            Some("gpt-5.5-pro".to_string())
        );
        assert_eq!(ModelCatalog::get_normalized_model(&catalog, "unknown-model"), None);
        assert_eq!(
            ModelCatalog::resolve_normalized_model(&catalog, "my-codex"),
            "gpt-5.3-codex"
        );
        // Arc<dyn ModelCatalog> wiring compiles and dispatches.
        let shared = shared_model_catalog();
        assert_eq!(shared.resolve_normalized_model("gpt-5"), "gpt-5.5");
    }

    #[test]
    fn model_profile_provider_seam_exposes_table_order_and_exact_profiles() {
        let provider = RequestModelCatalog;
        let defaults = ModelProfileProvider::default_models(&provider);
        assert_eq!(defaults.len(), 15);
        assert_eq!(defaults[0], "gpt-5.3-codex");
        assert_eq!(defaults[1], "gpt-5.4");
        assert_eq!(defaults[14], "gpt-5-nano");

        // Exact-key lookup only — aliases do NOT hit (the matrix re-resolves).
        assert!(ModelProfileProvider::profile(&provider, "gpt-5-codex").is_none());
        let profile = ModelProfileProvider::profile(&provider, "gpt-5.3-codex")
            .expect("canonical key resolves");
        assert_eq!(profile.normalized_model, "gpt-5.3-codex");
        assert_eq!(profile.prompt_family, ModelFamily::Gpt5Codex);
        assert_eq!(profile.default_reasoning_effort, ModelReasoningEffort::High);
        assert_eq!(
            profile.supported_reasoning_efforts,
            vec![
                ModelReasoningEffort::Low,
                ModelReasoningEffort::Medium,
                ModelReasoningEffort::High,
                ModelReasoningEffort::Xhigh,
            ]
        );
        assert!(!profile.capabilities.tool_search);
    }

    #[test]
    fn capability_policy_store_shares_buckets_through_this_catalog() {
        use cma_accounts::capability_policy::CapabilityPolicyStore;
        let mut store = CapabilityPolicyStore::with_catalog(std::sync::Arc::new(RequestModelCatalog));
        store.record_success("id:acct", "openai/gpt-5-codex-high", 1_000);
        let snapshot = store
            .get_snapshot("id:acct", "gpt-5.3-codex")
            .expect("alias and canonical id share one bucket");
        assert_eq!(snapshot.successes, 1);
    }
}
