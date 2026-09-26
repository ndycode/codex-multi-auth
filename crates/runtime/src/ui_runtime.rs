//! Port of `lib/runtime/ui-runtime.ts` — applies plugin-config UI settings to
//! the process-global UI runtime options, plus the shared `getStatusMarker`
//! (duplicated in TS by `status-marker.ts`; the duplicate lives in
//! [`crate::current_account::get_runtime_status_marker`]).
//!
//! Dependency note: `cma-runtime` does not depend on `cma-tui` (ARCHITECTURE
//! §4 DAG — the manager links both). The TS function already took
//! `setUiRuntimeOptions` as an injected parameter, so the Rust port keeps the
//! same DI shape: this module extracts the config values and hands them to
//! the injected setter; `cma-manager` wires in
//! `cma_tui::runtime_options::set_ui_runtime_options`.

use cma_config::getters::{get_codex_tui_color_profile, get_codex_tui_glyph_mode, get_codex_tui_v2};
use cma_config::load::load_plugin_config;
use cma_core::schemas::plugin_config::{CodexTuiColorProfile, CodexTuiGlyphMode, PluginConfig};

/// Status kinds accepted by the status-marker helpers
/// (TS `"ok" | "warning" | "error"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeStatus {
    Ok,
    Warning,
    Error,
}

/// The `{v2Enabled, colorProfile, glyphMode}` object literal the TS passed to
/// `setUiRuntimeOptions`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UiRuntimeConfigValues {
    pub v2_enabled: bool,
    pub color_profile: CodexTuiColorProfile,
    pub glyph_mode: CodexTuiGlyphMode,
}

/// Pure extraction of the UI runtime settings from the plugin config (the
/// argument the TS built inline; also `resolveUiRuntimeFromConfig`).
pub fn resolve_ui_runtime_from_config(plugin_config: &PluginConfig) -> UiRuntimeConfigValues {
    UiRuntimeConfigValues {
        v2_enabled: get_codex_tui_v2(plugin_config),
        color_profile: get_codex_tui_color_profile(plugin_config),
        glyph_mode: get_codex_tui_glyph_mode(plugin_config),
    }
}

/// `applyUiRuntimeFromConfig(pluginConfig, setUiRuntimeOptions)` — pushes the
/// extracted values through the injected setter and returns its result (the
/// resolved `UiRuntimeOptions` when wired to the cma-tui global).
pub fn apply_ui_runtime_from_config<R>(
    plugin_config: &PluginConfig,
    set_ui_runtime_options: impl FnOnce(UiRuntimeConfigValues) -> R,
) -> R {
    set_ui_runtime_options(resolve_ui_runtime_from_config(plugin_config))
}

/// `resolveUiRuntimeEntry` — trivial
/// `applyUiRuntimeFromConfig(loadPluginConfig())` indirection.
pub fn resolve_ui_runtime_entry<R>(
    set_ui_runtime_options: impl FnOnce(UiRuntimeConfigValues) -> R,
) -> R {
    apply_ui_runtime_from_config(&load_plugin_config(), set_ui_runtime_options)
}

/// The slice of the TS `UiRuntimeOptions` the status marker reads:
/// `v2Enabled` + `theme.glyphs.check` / `theme.glyphs.cross`. The manager
/// builds this from the live `cma_tui` runtime options.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusMarkerTheme {
    pub v2_enabled: bool,
    /// `ui.theme.glyphs.check` (unicode `✓` or ascii `+`).
    pub check: String,
    /// `ui.theme.glyphs.cross` (unicode `✗` or ascii `x`).
    pub cross: String,
}

/// `getStatusMarker` — v2 disabled: `✓` / `!` / `✗`; v2 enabled: the theme's
/// check/cross glyphs (warning stays `"!"`).
pub fn get_status_marker(ui: &StatusMarkerTheme, status: RuntimeStatus) -> String {
    if !ui.v2_enabled {
        return match status {
            RuntimeStatus::Ok => "\u{2713}".to_string(),
            RuntimeStatus::Warning => "!".to_string(),
            RuntimeStatus::Error => "\u{2717}".to_string(),
        };
    }
    match status {
        RuntimeStatus::Ok => ui.check.clone(),
        RuntimeStatus::Warning => "!".to_string(),
        RuntimeStatus::Error => ui.cross.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ui-runtime.test.ts: marker fallback matrix.
    #[test]
    fn status_marker_uses_legacy_glyphs_when_v2_disabled() {
        let ui = StatusMarkerTheme {
            v2_enabled: false,
            check: "+".to_string(),
            cross: "x".to_string(),
        };
        assert_eq!(get_status_marker(&ui, RuntimeStatus::Ok), "\u{2713}");
        assert_eq!(get_status_marker(&ui, RuntimeStatus::Warning), "!");
        assert_eq!(get_status_marker(&ui, RuntimeStatus::Error), "\u{2717}");
    }

    #[test]
    fn status_marker_uses_theme_glyphs_when_v2_enabled() {
        let ui = StatusMarkerTheme {
            v2_enabled: true,
            check: "+".to_string(),
            cross: "x".to_string(),
        };
        assert_eq!(get_status_marker(&ui, RuntimeStatus::Ok), "+");
        assert_eq!(get_status_marker(&ui, RuntimeStatus::Warning), "!");
        assert_eq!(get_status_marker(&ui, RuntimeStatus::Error), "x");
    }

    // ui-runtime-entry.test.ts: config values are pushed into the injected
    // setter.
    #[test]
    fn apply_ui_runtime_from_config_pushes_config_values() {
        let config = PluginConfig {
            codex_tui_v2: Some(false),
            codex_tui_color_profile: Some(CodexTuiColorProfile::Ansi16),
            codex_tui_glyph_mode: Some(CodexTuiGlyphMode::Unicode),
            ..PluginConfig::default()
        };
        let applied = apply_ui_runtime_from_config(&config, |values| values);
        assert!(!applied.v2_enabled);
        assert_eq!(applied.color_profile, CodexTuiColorProfile::Ansi16);
        assert_eq!(applied.glyph_mode, CodexTuiGlyphMode::Unicode);
    }

    #[test]
    fn resolve_defaults_follow_config_getters() {
        let values = resolve_ui_runtime_from_config(&PluginConfig::default());
        // Getter defaults: v2 on, truecolor, ascii (spec 01 §5.4).
        assert!(values.v2_enabled);
        assert_eq!(values.color_profile, CodexTuiColorProfile::Truecolor);
        assert_eq!(values.glyph_mode, CodexTuiGlyphMode::Ascii);
    }
}
