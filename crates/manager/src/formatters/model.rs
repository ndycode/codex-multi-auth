//! Port of `lib/codex-manager/formatters/model-formatters.ts`.

use cma_core::model_family::ModelFamily;
use cma_request::model_map::{
    ModelCapabilities, get_model_capabilities, get_model_profile, resolve_normalized_model,
};

/// TS `ModelInspection`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelInspection {
    pub requested: String,
    pub normalized: String,
    pub remapped: bool,
    pub prompt_family: ModelFamily,
    pub capabilities: ModelCapabilities,
}

/// TS `inspectRequestedModel(requestedModel)`.
pub fn inspect_requested_model(requested_model: &str) -> ModelInspection {
    let normalized = resolve_normalized_model(Some(requested_model));
    let profile = get_model_profile(Some(normalized));
    ModelInspection {
        requested: requested_model.to_string(),
        normalized: normalized.to_string(),
        remapped: requested_model != normalized,
        prompt_family: profile.prompt_family,
        capabilities: get_model_capabilities(Some(normalized)),
    }
}

/// TS `formatModelInspection(model)` — FROZEN user-visible string.
pub fn format_model_inspection(model: &ModelInspection) -> String {
    let route = if model.remapped {
        format!("{} -> {}", model.requested, model.normalized)
    } else {
        model.normalized.clone()
    };
    [
        route,
        format!("prompt family {}", model.prompt_family.as_str()),
        format!(
            "tool search {}",
            if model.capabilities.tool_search { "yes" } else { "no" }
        ),
        format!(
            "computer use {}",
            if model.capabilities.computer_use { "yes" } else { "no" }
        ),
    ]
    .join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from test/codex-manager-formatters.test.ts ("model formatters").

    #[test]
    fn inspect_requested_model_reports_remapping_consistently() {
        let inspection = inspect_requested_model("gpt-5.3-codex");
        assert_eq!(inspection.requested, "gpt-5.3-codex");
        assert_eq!(
            inspection.remapped,
            inspection.requested != inspection.normalized
        );
    }

    #[test]
    fn format_model_inspection_shows_route_and_capability_flags() {
        let family = inspect_requested_model("gpt-5.3-codex").prompt_family;
        let plain = format_model_inspection(&ModelInspection {
            requested: "m".to_string(),
            normalized: "m".to_string(),
            remapped: false,
            prompt_family: family,
            capabilities: ModelCapabilities {
                tool_search: true,
                computer_use: false,
                compaction: false,
            },
        });
        assert!(plain.contains("m | prompt family "));
        assert!(plain.contains("tool search yes"));
        assert!(plain.contains("computer use no"));

        let remapped = format_model_inspection(&ModelInspection {
            requested: "alias".to_string(),
            normalized: "real".to_string(),
            remapped: true,
            prompt_family: family,
            capabilities: ModelCapabilities {
                tool_search: false,
                computer_use: true,
                compaction: false,
            },
        });
        assert!(remapped.contains("alias -> real"));
    }
}
