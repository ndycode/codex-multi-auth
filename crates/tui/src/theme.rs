//! Port of `lib/ui/theme.ts` — shared terminal theme primitives.
//!
//! 3 color profiles × 2 palettes × 4 accents, glyph sets, and the
//! NO_COLOR/FORCE_COLOR/TTY color gate (ui-04). All escape sequences are
//! byte-exact copies of the TS source (spec 12 §3).

use std::io::IsTerminal;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiColorProfile {
    Ansi16,
    Ansi256,
    Truecolor,
}

impl UiColorProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            UiColorProfile::Ansi16 => "ansi16",
            UiColorProfile::Ansi256 => "ansi256",
            UiColorProfile::Truecolor => "truecolor",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ansi16" => Some(UiColorProfile::Ansi16),
            "ansi256" => Some(UiColorProfile::Ansi256),
            "truecolor" => Some(UiColorProfile::Truecolor),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiGlyphMode {
    Ascii,
    Unicode,
    Auto,
}

impl UiGlyphMode {
    pub fn as_str(self) -> &'static str {
        match self {
            UiGlyphMode::Ascii => "ascii",
            UiGlyphMode::Unicode => "unicode",
            UiGlyphMode::Auto => "auto",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ascii" => Some(UiGlyphMode::Ascii),
            "unicode" => Some(UiGlyphMode::Unicode),
            "auto" => Some(UiGlyphMode::Auto),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiPalette {
    Green,
    Blue,
}

impl UiPalette {
    pub fn as_str(self) -> &'static str {
        match self {
            UiPalette::Green => "green",
            UiPalette::Blue => "blue",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "green" => Some(UiPalette::Green),
            "blue" => Some(UiPalette::Blue),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiAccent {
    Green,
    Cyan,
    Blue,
    Yellow,
}

impl UiAccent {
    pub fn as_str(self) -> &'static str {
        match self {
            UiAccent::Green => "green",
            UiAccent::Cyan => "cyan",
            UiAccent::Blue => "blue",
            UiAccent::Yellow => "yellow",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "green" => Some(UiAccent::Green),
            "cyan" => Some(UiAccent::Cyan),
            "blue" => Some(UiAccent::Blue),
            "yellow" => Some(UiAccent::Yellow),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiGlyphSet {
    pub selected: &'static str,
    pub unselected: &'static str,
    pub bullet: &'static str,
    pub check: &'static str,
    pub cross: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiThemeColors {
    pub reset: String,
    pub dim: String,
    pub muted: String,
    pub heading: String,
    pub primary: String,
    pub accent: String,
    pub success: String,
    pub warning: String,
    pub danger: String,
    pub border: String,
    pub focus_bg: String,
    pub focus_text: String,
}

/// NOTE: `glyph_mode` keeps the **requested** mode (may be `Auto`); only
/// `glyphs` reflects the resolved mode. The quota-bar renderer keys off the
/// stored requested mode deliberately (ui-03).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiTheme {
    pub profile: UiColorProfile,
    pub glyph_mode: UiGlyphMode,
    pub glyphs: UiGlyphSet,
    pub colors: UiThemeColors,
}

fn ansi16(code: u32) -> String {
    format!("\x1b[{code}m")
}

fn ansi256(code: u32) -> String {
    format!("\x1b[38;5;{code}m")
}

fn truecolor(r: u32, g: u32, b: u32) -> String {
    format!("\x1b[38;2;{r};{g};{b}m")
}

fn ansi256_bg(code: u32) -> String {
    format!("\x1b[48;5;{code}m")
}

fn truecolor_bg(r: u32, g: u32, b: u32) -> String {
    format!("\x1b[48;2;{r};{g};{b}m")
}

/// Testable core of `resolveGlyphMode("auto")`: `"unicode"` iff `WT_SESSION`
/// is defined (any value) OR `TERM_PROGRAM === "vscode"` OR lowercased `TERM`
/// contains `"xterm"`.
pub(crate) fn resolve_glyph_mode_from(
    mode: UiGlyphMode,
    wt_session_defined: bool,
    term_program: Option<&str>,
    term: Option<&str>,
) -> UiGlyphMode {
    if mode != UiGlyphMode::Auto {
        return mode;
    }
    let is_likely_unicode_safe = wt_session_defined
        || term_program == Some("vscode")
        || term
            .map(|t| t.to_lowercase().contains("xterm"))
            .unwrap_or(false);
    if is_likely_unicode_safe {
        UiGlyphMode::Unicode
    } else {
        UiGlyphMode::Ascii
    }
}

fn resolve_glyph_mode(mode: UiGlyphMode) -> UiGlyphMode {
    resolve_glyph_mode_from(
        mode,
        std::env::var_os("WT_SESSION").is_some(),
        std::env::var("TERM_PROGRAM").ok().as_deref(),
        std::env::var("TERM").ok().as_deref(),
    )
}

fn get_glyphs(mode: UiGlyphMode) -> UiGlyphSet {
    if mode == UiGlyphMode::Unicode {
        return UiGlyphSet {
            selected: "\u{25c6}",   // ◆
            unselected: "\u{25cb}", // ○
            bullet: "\u{2022}",     // •
            check: "\u{2713}",      // ✓
            cross: "\u{2717}",      // ✗
        };
    }
    UiGlyphSet {
        selected: ">",
        unselected: "o",
        bullet: "-",
        check: "+",
        cross: "x",
    }
}

fn accent_color_for_profile(profile: UiColorProfile, accent: UiAccent) -> String {
    match profile {
        UiColorProfile::Truecolor => match accent {
            UiAccent::Cyan => truecolor(34, 211, 238),
            UiAccent::Blue => truecolor(59, 130, 246),
            UiAccent::Yellow => truecolor(245, 158, 11),
            UiAccent::Green => truecolor(74, 222, 128),
        },
        UiColorProfile::Ansi256 => match accent {
            UiAccent::Cyan => ansi256(51),
            UiAccent::Blue => ansi256(75),
            UiAccent::Yellow => ansi256(214),
            UiAccent::Green => ansi256(83),
        },
        UiColorProfile::Ansi16 => match accent {
            UiAccent::Cyan => ansi16(96),
            UiAccent::Blue => ansi16(94),
            UiAccent::Yellow => ansi16(93),
            UiAccent::Green => ansi16(92),
        },
    }
}

fn get_colors(profile: UiColorProfile, palette: UiPalette, accent: UiAccent) -> UiThemeColors {
    let accent_color = accent_color_for_profile(profile, accent);
    let is_blue_palette = palette == UiPalette::Blue;
    match profile {
        UiColorProfile::Truecolor => UiThemeColors {
            reset: "\x1b[0m".to_string(),
            dim: "\x1b[2m".to_string(),
            muted: truecolor(148, 163, 184),
            heading: truecolor(240, 253, 244),
            primary: if is_blue_palette {
                truecolor(96, 165, 250)
            } else {
                truecolor(74, 222, 128)
            },
            accent: accent_color,
            success: if is_blue_palette {
                truecolor(96, 165, 250)
            } else {
                truecolor(74, 222, 128)
            },
            warning: truecolor(245, 158, 11),
            danger: truecolor(239, 68, 68),
            border: if is_blue_palette {
                truecolor(59, 130, 246)
            } else {
                truecolor(34, 197, 94)
            },
            focus_bg: if is_blue_palette {
                truecolor_bg(37, 99, 235)
            } else {
                truecolor_bg(22, 101, 52)
            },
            focus_text: truecolor(248, 250, 252),
        },
        UiColorProfile::Ansi256 => UiThemeColors {
            reset: "\x1b[0m".to_string(),
            dim: "\x1b[2m".to_string(),
            muted: ansi256(102),
            heading: ansi256(255),
            primary: if is_blue_palette {
                ansi256(75)
            } else {
                ansi256(83)
            },
            accent: accent_color,
            success: if is_blue_palette {
                ansi256(75)
            } else {
                ansi256(83)
            },
            warning: ansi256(214),
            danger: ansi256(196),
            border: if is_blue_palette {
                ansi256(27)
            } else {
                ansi256(40)
            },
            focus_bg: if is_blue_palette {
                ansi256_bg(26)
            } else {
                ansi256_bg(28)
            },
            focus_text: ansi256(231),
        },
        UiColorProfile::Ansi16 => UiThemeColors {
            reset: "\x1b[0m".to_string(),
            dim: "\x1b[2m".to_string(),
            muted: ansi16(37),
            heading: ansi16(97),
            primary: if is_blue_palette {
                ansi16(94)
            } else {
                ansi16(92)
            },
            accent: accent_color,
            success: if is_blue_palette {
                ansi16(94)
            } else {
                ansi16(92)
            },
            warning: ansi16(93),
            danger: ansi16(91),
            border: if is_blue_palette {
                ansi16(94)
            } else {
                ansi16(92)
            },
            focus_bg: if is_blue_palette {
                "\x1b[104m".to_string()
            } else {
                "\x1b[102m".to_string()
            },
            focus_text: "\x1b[30m".to_string(),
        },
    }
}

/// Testable core of `shouldDisableColor` (ui-04).
///
/// - `force_color` `"0"`/`"false"` (trimmed, lowercased) => disable;
///   any other non-empty value => force color ON (beats NO_COLOR and non-TTY).
/// - else `no_color` present as a string (any value, even `""`) => disable.
/// - else `!is_tty`.
pub fn should_disable_color_from(
    force_color: Option<&str>,
    no_color: Option<&str>,
    is_tty: bool,
) -> bool {
    let force = force_color.unwrap_or("").trim().to_lowercase();
    if force == "0" || force == "false" {
        return true;
    }
    if !force.is_empty() {
        return false; // explicit force-on wins over TTY/NO_COLOR
    }
    if no_color.is_some() {
        return true;
    }
    !is_tty
}

/// Live `shouldDisableColor()` — samples the process env and stdout TTY-ness.
pub fn should_disable_color() -> bool {
    let force = std::env::var("FORCE_COLOR").ok();
    let no_color = std::env::var_os("NO_COLOR").map(|v| v.to_string_lossy().into_owned());
    should_disable_color_from(
        force.as_deref(),
        no_color.as_deref(),
        std::io::stdout().is_terminal(),
    )
}

/// Replace every color token with an empty string (color-disabled theme).
fn strip_colors(_colors: UiThemeColors) -> UiThemeColors {
    UiThemeColors {
        reset: String::new(),
        dim: String::new(),
        muted: String::new(),
        heading: String::new(),
        primary: String::new(),
        accent: String::new(),
        success: String::new(),
        warning: String::new(),
        danger: String::new(),
        border: String::new(),
        focus_bg: String::new(),
        focus_text: String::new(),
    }
}

/// Options bag for [`create_ui_theme`], mirroring the TS optional fields.
#[derive(Debug, Clone, Copy, Default)]
pub struct CreateUiThemeOptions {
    pub profile: Option<UiColorProfile>,
    pub glyph_mode: Option<UiGlyphMode>,
    pub palette: Option<UiPalette>,
    pub accent: Option<UiAccent>,
    pub disable_color: Option<bool>,
}

/// Create a UI theme. Defaults: profile `truecolor`, glyphMode `ascii`,
/// palette `green`, accent `green`; `disable_color` defaults to the live
/// [`should_disable_color`] result (env + stdout TTY).
pub fn create_ui_theme(options: CreateUiThemeOptions) -> UiTheme {
    let profile = options.profile.unwrap_or(UiColorProfile::Truecolor);
    let glyph_mode = options.glyph_mode.unwrap_or(UiGlyphMode::Ascii);
    let palette = options.palette.unwrap_or(UiPalette::Green);
    let accent = options.accent.unwrap_or(UiAccent::Green);
    let resolved_glyph_mode = resolve_glyph_mode(glyph_mode);
    let colors = get_colors(profile, palette, accent);
    // ui-04: honor NO_COLOR / FORCE_COLOR / non-TTY by blanking color tokens.
    // The caller may also force this explicitly (snapshot-stable output).
    let disable_color = options.disable_color.unwrap_or_else(should_disable_color);
    UiTheme {
        profile,
        glyph_mode,
        glyphs: get_glyphs(resolved_glyph_mode),
        colors: if disable_color {
            strip_colors(colors)
        } else {
            colors
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from test/ui-theme.test.ts. Color-token assertions opt into color
    // explicitly (disable_color: Some(false)) so the test env's NO_COLOR /
    // FORCE_COLOR cannot blank the tokens (ui-04).

    #[test]
    fn uses_defaults_when_options_are_omitted() {
        let theme = create_ui_theme(CreateUiThemeOptions {
            disable_color: Some(false),
            ..Default::default()
        });
        assert_eq!(theme.profile, UiColorProfile::Truecolor);
        assert_eq!(theme.glyph_mode, UiGlyphMode::Ascii);
        assert!(!theme.glyphs.selected.is_empty());
        assert_eq!(theme.colors.reset, "\x1b[0m");
        assert!(theme.colors.primary.contains("\x1b["));
        assert!(theme.colors.focus_bg.contains("\x1b["));
        assert!(theme.colors.focus_text.contains("\x1b["));
    }

    #[test]
    fn uses_ansi16_color_profile_when_requested() {
        let theme = create_ui_theme(CreateUiThemeOptions {
            profile: Some(UiColorProfile::Ansi16),
            disable_color: Some(false),
            ..Default::default()
        });
        assert_eq!(theme.profile, UiColorProfile::Ansi16);
        assert!(theme.colors.accent.contains("\x1b["));
        assert_eq!(theme.colors.accent, "\x1b[92m");
        assert_eq!(theme.colors.focus_bg, "\x1b[102m");
        assert_eq!(theme.colors.focus_text, "\x1b[30m");
    }

    #[test]
    fn uses_ansi256_color_profile_when_requested() {
        let theme = create_ui_theme(CreateUiThemeOptions {
            profile: Some(UiColorProfile::Ansi256),
            disable_color: Some(false),
            ..Default::default()
        });
        assert_eq!(theme.profile, UiColorProfile::Ansi256);
        assert!(theme.colors.accent.contains("38;5;"));
        assert_eq!(theme.colors.accent, "\x1b[38;5;83m");
        assert_eq!(theme.colors.focus_bg, "\x1b[48;5;28m");
    }

    #[test]
    fn supports_blue_palette_and_cyan_accent_overrides() {
        let theme = create_ui_theme(CreateUiThemeOptions {
            profile: Some(UiColorProfile::Truecolor),
            palette: Some(UiPalette::Blue),
            accent: Some(UiAccent::Cyan),
            disable_color: Some(false),
            ..Default::default()
        });
        assert_eq!(theme.colors.primary, "\x1b[38;2;96;165;250m");
        assert_eq!(theme.colors.accent, "\x1b[38;2;34;211;238m");
        assert_eq!(theme.colors.focus_bg, "\x1b[48;2;37;99;235m");
        assert_eq!(theme.colors.border, "\x1b[38;2;59;130;246m");
    }

    #[test]
    fn uses_unicode_glyph_set_when_explicitly_requested() {
        let theme = create_ui_theme(CreateUiThemeOptions {
            glyph_mode: Some(UiGlyphMode::Unicode),
            ..Default::default()
        });
        assert_eq!(theme.glyphs.selected, "\u{25c6}");
        assert_eq!(theme.glyphs.check, "\u{2713}");
    }

    #[test]
    fn keeps_ascii_glyph_set_when_explicitly_requested() {
        let theme = create_ui_theme(CreateUiThemeOptions {
            glyph_mode: Some(UiGlyphMode::Ascii),
            ..Default::default()
        });
        assert_eq!(theme.glyphs.selected, ">");
        assert_eq!(theme.glyphs.check, "+");
    }

    #[test]
    fn resolve_glyph_mode_auto_heuristics() {
        // WT_SESSION defined with ANY value => unicode.
        assert_eq!(
            resolve_glyph_mode_from(UiGlyphMode::Auto, true, None, None),
            UiGlyphMode::Unicode
        );
        assert_eq!(
            resolve_glyph_mode_from(UiGlyphMode::Auto, false, Some("vscode"), None),
            UiGlyphMode::Unicode
        );
        assert_eq!(
            resolve_glyph_mode_from(UiGlyphMode::Auto, false, None, Some("XTERM-256color")),
            UiGlyphMode::Unicode
        );
        assert_eq!(
            resolve_glyph_mode_from(UiGlyphMode::Auto, false, Some("iTerm.app"), Some("dumb")),
            UiGlyphMode::Ascii
        );
        // Non-auto modes pass through untouched.
        assert_eq!(
            resolve_glyph_mode_from(UiGlyphMode::Ascii, true, Some("vscode"), Some("xterm")),
            UiGlyphMode::Ascii
        );
    }

    #[test]
    fn no_color_disables_with_any_value() {
        assert!(should_disable_color_from(None, Some(""), true));
        assert!(should_disable_color_from(None, Some("1"), true));
    }

    #[test]
    fn force_color_zero_disables_even_on_a_tty() {
        assert!(should_disable_color_from(Some("0"), None, true));
        assert!(should_disable_color_from(Some("false"), None, true));
        assert!(should_disable_color_from(Some(" FALSE "), None, true));
    }

    #[test]
    fn force_color_truthy_forces_color_on() {
        assert!(!should_disable_color_from(Some("1"), Some("1"), false));
    }

    #[test]
    fn disables_color_when_stdout_is_not_a_tty() {
        assert!(should_disable_color_from(None, None, false));
    }

    #[test]
    fn enables_color_on_a_plain_tty_with_no_overrides() {
        assert!(!should_disable_color_from(None, None, true));
    }

    #[test]
    fn blanks_all_color_tokens_when_disable_color_is_true() {
        let theme = create_ui_theme(CreateUiThemeOptions {
            disable_color: Some(true),
            ..Default::default()
        });
        assert_eq!(theme.colors.reset, "");
        assert_eq!(theme.colors.primary, "");
        assert_eq!(theme.colors.focus_bg, "");
        // glyphs are unaffected by color gating
        assert!(!theme.glyphs.selected.is_empty());
    }
}
