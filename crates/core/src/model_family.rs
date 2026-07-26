//! Port of the `MODEL_FAMILIES` / `DEFAULT_MODEL` slice of
//! `lib/request/helpers/model-map.ts` (spec 06 §"model-map").
//!
//! Only the family enum and the two default-model constants live in core (they
//! are needed by the storage schemas — de-cycling move #1 in ARCHITECTURE §4).
//! The full alias/profile tables stay in `cma-request::model_map`.

use serde::{Deserialize, Serialize};

/// Model family type for prompt selection (TS `PromptModelFamily`).
/// TS declares `type ModelFamily = PromptModelFamily`.
pub type PromptModelFamily = ModelFamily;

/// All supported model families. Used for per-family account rotation and
/// rate-limit tracking.
///
/// Serde renames are EXACT wire/persisted literals:
/// `"gpt-5-codex"`, `"codex-max"`, `"codex"`, `"gpt-5.2"`, `"gpt-5.1"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum ModelFamily {
    #[serde(rename = "gpt-5-codex")]
    Gpt5Codex,
    #[serde(rename = "codex-max")]
    CodexMax,
    #[serde(rename = "codex")]
    Codex,
    #[serde(rename = "gpt-5.2")]
    Gpt5_2,
    #[serde(rename = "gpt-5.1")]
    Gpt5_1,
}

/// All supported model families, in the TS declaration order
/// (TS `MODEL_FAMILIES`).
pub const MODEL_FAMILIES: [ModelFamily; 5] = [
    ModelFamily::Gpt5Codex,
    ModelFamily::CodexMax,
    ModelFamily::Codex,
    ModelFamily::Gpt5_2,
    ModelFamily::Gpt5_1,
];

/// Default model when no/unknown model is requested (TS `DEFAULT_MODEL`).
pub const DEFAULT_MODEL: &str = "gpt-5.5";

/// Model used for diagnostic live/quota probes (`check`, `report`, `best`).
/// Deliberately distinct from [`DEFAULT_MODEL`]: GPT-5.6 is the latest general
/// family (issue #627), so the probe leads with it, while `DEFAULT_MODEL`
/// stays on 5.5 so actual request routing and the legacy `gpt-5` alias remain
/// opt-in per 2.5.0. Bare `gpt-5.6` aliases to Sol; the canonical id is pinned
/// so probe display and report `modelSelection` read `gpt-5.6-sol` without a
/// remap arrow. (TS `DEFAULT_PROBE_MODEL`.)
pub const DEFAULT_PROBE_MODEL: &str = "gpt-5.6-sol";

impl ModelFamily {
    /// The exact family literal (`"gpt-5-codex"`, `"codex-max"`, `"codex"`,
    /// `"gpt-5.2"`, `"gpt-5.1"`).
    pub const fn as_str(self) -> &'static str {
        match self {
            ModelFamily::Gpt5Codex => "gpt-5-codex",
            ModelFamily::CodexMax => "codex-max",
            ModelFamily::Codex => "codex",
            ModelFamily::Gpt5_2 => "gpt-5.2",
            ModelFamily::Gpt5_1 => "gpt-5.1",
        }
    }

    /// Exact-match parse of a family literal. Model-id → family RESOLUTION
    /// (`getModelFamily`) lives in `cma-request::model_map`, not here.
    pub fn parse(value: &str) -> Option<Self> {
        MODEL_FAMILIES
            .iter()
            .copied()
            .find(|family| family.as_str() == value)
    }
}

impl std::fmt::Display for ModelFamily {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Error returned by [`ModelFamily`]'s `FromStr` for unknown literals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownModelFamilyError(pub String);

impl std::fmt::Display for UnknownModelFamilyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unknown model family: {}", self.0)
    }
}

impl std::error::Error for UnknownModelFamilyError {}

impl std::str::FromStr for ModelFamily {
    type Err = UnknownModelFamilyError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        ModelFamily::parse(s).ok_or_else(|| UnknownModelFamilyError(s.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_families_are_ordered_exactly_as_ts() {
        let literals: Vec<&str> = MODEL_FAMILIES.iter().map(|f| f.as_str()).collect();
        assert_eq!(
            literals,
            vec!["gpt-5-codex", "codex-max", "codex", "gpt-5.2", "gpt-5.1"]
        );
    }

    #[test]
    fn default_models_match_ts() {
        assert_eq!(DEFAULT_MODEL, "gpt-5.5");
        assert_eq!(DEFAULT_PROBE_MODEL, "gpt-5.6-sol");
    }

    #[test]
    fn serde_renames_are_exact() {
        assert_eq!(
            serde_json::to_string(&ModelFamily::Gpt5Codex).unwrap(),
            "\"gpt-5-codex\""
        );
        assert_eq!(
            serde_json::to_string(&ModelFamily::CodexMax).unwrap(),
            "\"codex-max\""
        );
        assert_eq!(serde_json::to_string(&ModelFamily::Codex).unwrap(), "\"codex\"");
        assert_eq!(
            serde_json::to_string(&ModelFamily::Gpt5_2).unwrap(),
            "\"gpt-5.2\""
        );
        assert_eq!(
            serde_json::to_string(&ModelFamily::Gpt5_1).unwrap(),
            "\"gpt-5.1\""
        );

        for family in MODEL_FAMILIES {
            let round: ModelFamily =
                serde_json::from_str(&serde_json::to_string(&family).unwrap()).unwrap();
            assert_eq!(round, family);
        }
    }

    #[test]
    fn parse_is_exact_match_only() {
        assert_eq!(ModelFamily::parse("gpt-5.2"), Some(ModelFamily::Gpt5_2));
        assert_eq!(ModelFamily::parse("codex"), Some(ModelFamily::Codex));
        // No alias resolution in core — "gpt-5.3-codex" is a MODEL, not a family.
        assert_eq!(ModelFamily::parse("gpt-5.3-codex"), None);
        assert_eq!(ModelFamily::parse("GPT-5.2"), None);
        assert_eq!(ModelFamily::parse(""), None);
    }

    #[test]
    fn from_str_round_trips_display() {
        for family in MODEL_FAMILIES {
            let parsed: ModelFamily = family.to_string().parse().unwrap();
            assert_eq!(parsed, family);
        }
        assert!("gpt-6".parse::<ModelFamily>().is_err());
    }
}
