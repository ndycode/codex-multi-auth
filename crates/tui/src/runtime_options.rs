//! Port of `lib/ui/runtime.ts` — process-global mutable UI runtime options.
//!
//! The TS default `theme` was computed once at module load (sampling
//! NO_COLOR/FORCE_COLOR/TTY exactly once); we preserve "evaluated once"
//! semantics with a `LazyLock` (spec 12 §4). `set_ui_runtime_options` rebuilds
//! the theme via `create_ui_theme`, which re-evaluates `should_disable_color`
//! live.

use std::sync::{LazyLock, RwLock};

use crate::theme::{
    create_ui_theme, CreateUiThemeOptions, UiAccent, UiColorProfile, UiGlyphMode, UiPalette,
    UiTheme,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiRuntimeOptions {
    pub v2_enabled: bool,
    pub color_profile: UiColorProfile,
    pub glyph_mode: UiGlyphMode,
    pub palette: UiPalette,
    pub accent: UiAccent,
    pub theme: UiTheme,
}

/// Partial update for [`set_ui_runtime_options`] (`Partial<Omit<..,"theme">>`).
#[derive(Debug, Clone, Copy, Default)]
pub struct UiRuntimeOptionsPatch {
    pub v2_enabled: Option<bool>,
    pub color_profile: Option<UiColorProfile>,
    pub glyph_mode: Option<UiGlyphMode>,
    pub palette: Option<UiPalette>,
    pub accent: Option<UiAccent>,
}

/// The default theme instance, computed exactly once per process (mirrors the
/// TS module-load-time evaluation of `shouldDisableColor()`).
static DEFAULT_THEME: LazyLock<UiTheme> = LazyLock::new(|| {
    create_ui_theme(CreateUiThemeOptions {
        profile: Some(UiColorProfile::Truecolor),
        glyph_mode: Some(UiGlyphMode::Ascii),
        palette: Some(UiPalette::Green),
        accent: Some(UiAccent::Green),
        disable_color: None,
    })
});

fn default_options() -> UiRuntimeOptions {
    UiRuntimeOptions {
        v2_enabled: true,
        color_profile: UiColorProfile::Truecolor,
        glyph_mode: UiGlyphMode::Ascii,
        palette: UiPalette::Green,
        accent: UiAccent::Green,
        theme: DEFAULT_THEME.clone(),
    }
}

static RUNTIME_OPTIONS: LazyLock<RwLock<UiRuntimeOptions>> =
    LazyLock::new(|| RwLock::new(default_options()));

/// Update UI runtime options and recompute the derived theme. Unspecified
/// fields keep their current values. Returns the resolved options.
pub fn set_ui_runtime_options(options: UiRuntimeOptionsPatch) -> UiRuntimeOptions {
    let mut guard = RUNTIME_OPTIONS
        .write()
        .unwrap_or_else(|poison| poison.into_inner());
    let v2_enabled = options.v2_enabled.unwrap_or(guard.v2_enabled);
    let color_profile = options.color_profile.unwrap_or(guard.color_profile);
    let glyph_mode = options.glyph_mode.unwrap_or(guard.glyph_mode);
    let palette = options.palette.unwrap_or(guard.palette);
    let accent = options.accent.unwrap_or(guard.accent);
    *guard = UiRuntimeOptions {
        v2_enabled,
        color_profile,
        glyph_mode,
        palette,
        accent,
        // Re-evaluates should_disable_color() live, unlike the default theme.
        theme: create_ui_theme(CreateUiThemeOptions {
            profile: Some(color_profile),
            glyph_mode: Some(glyph_mode),
            palette: Some(palette),
            accent: Some(accent),
            disable_color: None,
        }),
    };
    guard.clone()
}

/// Returns the current UI runtime options (a clone of the live global; each
/// call observes the latest state, matching the TS live-object semantics).
pub fn get_ui_runtime_options() -> UiRuntimeOptions {
    RUNTIME_OPTIONS
        .read()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
}

/// Reset the UI runtime options to the default configuration (the theme is the
/// original default theme instance, NOT re-evaluated).
pub fn reset_ui_runtime_options() -> UiRuntimeOptions {
    let mut guard = RUNTIME_OPTIONS
        .write()
        .unwrap_or_else(|poison| poison.into_inner());
    *guard = default_options();
    guard.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    // Ported from test/ui-runtime.test.ts behaviors. These mutate the process
    // global, so they are serialized.

    #[test]
    #[serial]
    fn defaults_are_v2_truecolor_ascii_green() {
        reset_ui_runtime_options();
        let options = get_ui_runtime_options();
        assert!(options.v2_enabled);
        assert_eq!(options.color_profile, UiColorProfile::Truecolor);
        assert_eq!(options.glyph_mode, UiGlyphMode::Ascii);
        assert_eq!(options.palette, UiPalette::Green);
        assert_eq!(options.accent, UiAccent::Green);
        assert_eq!(options.theme.profile, UiColorProfile::Truecolor);
    }

    #[test]
    #[serial]
    fn set_merges_fields_and_rebuilds_theme() {
        reset_ui_runtime_options();
        let updated = set_ui_runtime_options(UiRuntimeOptionsPatch {
            color_profile: Some(UiColorProfile::Ansi256),
            glyph_mode: Some(UiGlyphMode::Unicode),
            ..Default::default()
        });
        // Unspecified fields kept their current values.
        assert!(updated.v2_enabled);
        assert_eq!(updated.palette, UiPalette::Green);
        // Theme rebuilt from the merged fields.
        assert_eq!(updated.color_profile, UiColorProfile::Ansi256);
        assert_eq!(updated.theme.profile, UiColorProfile::Ansi256);
        assert_eq!(updated.theme.glyph_mode, UiGlyphMode::Unicode);
        assert_eq!(updated.theme.glyphs.selected, "\u{25c6}");
        // The getter observes the update.
        assert_eq!(
            get_ui_runtime_options().color_profile,
            UiColorProfile::Ansi256
        );
        reset_ui_runtime_options();
    }

    #[test]
    #[serial]
    fn reset_restores_defaults() {
        set_ui_runtime_options(UiRuntimeOptionsPatch {
            v2_enabled: Some(false),
            palette: Some(UiPalette::Blue),
            ..Default::default()
        });
        let restored = reset_ui_runtime_options();
        assert!(restored.v2_enabled);
        assert_eq!(restored.palette, UiPalette::Green);
        // The restored theme is the original default instance's value.
        assert_eq!(restored.theme, DEFAULT_THEME.clone());
    }
}
