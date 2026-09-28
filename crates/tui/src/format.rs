//! Port of `lib/ui/format.ts` — tone-based text/badge/key-value formatting.
//!
//! DELIBERATE BUG PRESERVED (spec 12 §5 gotcha): `format_ui_badge` ignores
//! color-disabled themes — the hard-coded background/foreground start
//! sequences are emitted whenever `v2_enabled`; only the trailing reset comes
//! from the (possibly blanked) theme. Do NOT "fix" this: snapshot parity
//! depends on it.

use crate::runtime_options::UiRuntimeOptions;
use crate::theme::{UiAccent, UiColorProfile, UiPalette};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiTextTone {
    Primary,
    Heading,
    Accent,
    Muted,
    Success,
    Warning,
    Danger,
    Normal,
}

/// Badge tones — `UiTextTone` minus `Normal`/`Heading` (TS `Exclude<...>`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiBadgeTone {
    Primary,
    Accent,
    Success,
    Warning,
    Danger,
    Muted,
}

fn tone_color(ui: &UiRuntimeOptions, tone: UiTextTone) -> Option<&str> {
    let colors = &ui.theme.colors;
    match tone {
        UiTextTone::Primary => Some(&colors.primary),
        UiTextTone::Heading => Some(&colors.heading),
        UiTextTone::Accent => Some(&colors.accent),
        UiTextTone::Muted => Some(&colors.muted),
        UiTextTone::Success => Some(&colors.success),
        UiTextTone::Warning => Some(&colors.warning),
        UiTextTone::Danger => Some(&colors.danger),
        UiTextTone::Normal => None,
    }
}

/// `badgeStyleForTone` — hard-coded escape sequences per profile/accent/palette
/// (start; end is the theme reset).
fn badge_style_for_tone(ui: &UiRuntimeOptions, tone: UiBadgeTone) -> (&'static str, String) {
    let end = ui.theme.colors.reset.clone();
    let is_blue = ui.palette == UiPalette::Blue;
    let accent = ui.accent;
    if ui.color_profile == UiColorProfile::Truecolor {
        let accent_start = match accent {
            UiAccent::Cyan => "\x1b[48;2;8;89;106m\x1b[38;2;224;242;254m\x1b[1m",
            UiAccent::Blue => "\x1b[48;2;30;64;175m\x1b[38;2;219;234;254m\x1b[1m",
            UiAccent::Yellow => "\x1b[48;2;120;53;15m\x1b[38;2;255;247;237m\x1b[1m",
            UiAccent::Green => "\x1b[48;2;20;83;45m\x1b[38;2;220;252;231m\x1b[1m",
        };
        let success_start = if is_blue {
            "\x1b[48;2;30;64;175m\x1b[38;2;219;234;254m\x1b[1m"
        } else {
            "\x1b[48;2;20;83;45m\x1b[38;2;220;252;231m\x1b[1m"
        };
        let start = match tone {
            UiBadgeTone::Primary | UiBadgeTone::Accent => accent_start,
            UiBadgeTone::Success => success_start,
            UiBadgeTone::Warning => "\x1b[48;2;120;53;15m\x1b[38;2;255;247;237m\x1b[1m",
            UiBadgeTone::Danger => "\x1b[48;2;127;29;29m\x1b[38;2;254;226;226m\x1b[1m",
            UiBadgeTone::Muted => "\x1b[48;2;51;65;85m\x1b[38;2;226;232;240m\x1b[1m",
        };
        return (start, end);
    }

    if ui.color_profile == UiColorProfile::Ansi256 {
        let accent_start = match accent {
            UiAccent::Cyan => "\x1b[48;5;23m\x1b[38;5;159m\x1b[1m",
            UiAccent::Blue => "\x1b[48;5;19m\x1b[38;5;153m\x1b[1m",
            UiAccent::Yellow => "\x1b[48;5;94m\x1b[38;5;230m\x1b[1m",
            UiAccent::Green => "\x1b[48;5;22m\x1b[38;5;157m\x1b[1m",
        };
        let success_start = if is_blue {
            "\x1b[48;5;19m\x1b[38;5;153m\x1b[1m"
        } else {
            "\x1b[48;5;22m\x1b[38;5;157m\x1b[1m"
        };
        let start = match tone {
            UiBadgeTone::Primary | UiBadgeTone::Accent => accent_start,
            UiBadgeTone::Success => success_start,
            UiBadgeTone::Warning => "\x1b[48;5;94m\x1b[38;5;230m\x1b[1m",
            UiBadgeTone::Danger => "\x1b[48;5;88m\x1b[38;5;224m\x1b[1m",
            UiBadgeTone::Muted => "\x1b[48;5;240m\x1b[38;5;255m\x1b[1m",
        };
        return (start, end);
    }

    let accent_start = match accent {
        UiAccent::Cyan => "\x1b[46m\x1b[30m\x1b[1m",
        UiAccent::Blue => "\x1b[44m\x1b[97m\x1b[1m",
        UiAccent::Yellow => "\x1b[43m\x1b[30m\x1b[1m",
        UiAccent::Green => "\x1b[42m\x1b[30m\x1b[1m",
    };
    let success_start = if is_blue {
        "\x1b[44m\x1b[97m\x1b[1m"
    } else {
        "\x1b[42m\x1b[30m\x1b[1m"
    };
    let start = match tone {
        UiBadgeTone::Primary | UiBadgeTone::Accent => accent_start,
        UiBadgeTone::Success => success_start,
        UiBadgeTone::Warning => "\x1b[43m\x1b[30m\x1b[1m",
        UiBadgeTone::Danger => "\x1b[41m\x1b[97m\x1b[1m",
        UiBadgeTone::Muted => "\x1b[100m\x1b[97m\x1b[1m",
    };
    (start, end)
}

/// Colorize text according to the theme and tone. If `!ui.v2_enabled` or the
/// tone maps to no color, the text is returned unchanged.
pub fn paint_ui_text(ui: &UiRuntimeOptions, text: &str, tone: UiTextTone) -> String {
    if !ui.v2_enabled {
        return text.to_string();
    }
    match tone_color(ui, tone) {
        None => text.to_string(),
        Some(color) => format!("{color}{text}{}", ui.theme.colors.reset),
    }
}

pub fn format_ui_header(ui: &UiRuntimeOptions, title: &str) -> Vec<String> {
    if !ui.v2_enabled {
        return vec![title.to_string()];
    }
    // TS uses `title.length` (UTF-16 code units) for the divider width.
    let divider = "-".repeat(std::cmp::max(8, title.encode_utf16().count()));
    vec![
        paint_ui_text(ui, title, UiTextTone::Heading),
        paint_ui_text(ui, &divider, UiTextTone::Muted),
    ]
}

pub fn format_ui_section(ui: &UiRuntimeOptions, title: &str) -> Vec<String> {
    if !ui.v2_enabled {
        return vec![title.to_string()];
    }
    vec![paint_ui_text(ui, title, UiTextTone::Accent)]
}

pub fn format_ui_item(ui: &UiRuntimeOptions, text: &str, tone: UiTextTone) -> String {
    if !ui.v2_enabled {
        return format!("- {text}");
    }
    let bullet = paint_ui_text(ui, ui.theme.glyphs.bullet, UiTextTone::Muted);
    format!("{bullet} {}", paint_ui_text(ui, text, tone))
}

pub fn format_ui_key_value(
    ui: &UiRuntimeOptions,
    key: &str,
    value: &str,
    value_tone: UiTextTone,
) -> String {
    if !ui.v2_enabled {
        return format!("{key}: {value}");
    }
    let key_text = paint_ui_text(ui, &format!("{key}:"), UiTextTone::Muted);
    let value_text = paint_ui_text(ui, value, value_tone);
    format!("{key_text} {value_text}")
}

/// Format a badge label: `[label]`; with tone-specific hard-coded styling when
/// v2 is enabled (badge styling does NOT honor `disableColor` — bug-compatible,
/// see module docs).
pub fn format_ui_badge(ui: &UiRuntimeOptions, label: &str, tone: UiBadgeTone) -> String {
    let text = format!("[{label}]");
    if !ui.v2_enabled {
        return text;
    }
    let (start, end) = badge_style_for_tone(ui, tone);
    format!("{start}{text}{end}")
}

/// `quotaToneFromLeftPercent`: `<=15` danger, `<=35` warning, else success.
pub fn quota_tone_from_left_percent(left_percent: f64) -> UiTextTone {
    if left_percent <= 15.0 {
        return UiTextTone::Danger;
    }
    if left_percent <= 35.0 {
        return UiTextTone::Warning;
    }
    UiTextTone::Success
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{create_ui_theme, CreateUiThemeOptions, UiGlyphMode};

    // Fixtures ported from test/ui-format.test.ts.

    fn v2_ui() -> UiRuntimeOptions {
        UiRuntimeOptions {
            v2_enabled: true,
            color_profile: UiColorProfile::Truecolor,
            glyph_mode: UiGlyphMode::Ascii,
            palette: UiPalette::Green,
            accent: UiAccent::Green,
            // Force color on, independent of the test env (ui-04).
            theme: create_ui_theme(CreateUiThemeOptions {
                profile: Some(UiColorProfile::Truecolor),
                glyph_mode: Some(UiGlyphMode::Ascii),
                disable_color: Some(false),
                ..Default::default()
            }),
        }
    }

    fn legacy_ui() -> UiRuntimeOptions {
        UiRuntimeOptions {
            v2_enabled: false,
            color_profile: UiColorProfile::Ansi16,
            glyph_mode: UiGlyphMode::Ascii,
            palette: UiPalette::Green,
            accent: UiAccent::Green,
            theme: create_ui_theme(CreateUiThemeOptions {
                profile: Some(UiColorProfile::Ansi16),
                glyph_mode: Some(UiGlyphMode::Ascii),
                disable_color: Some(true),
                ..Default::default()
            }),
        }
    }

    #[test]
    fn returns_plain_text_in_legacy_mode() {
        let ui = legacy_ui();
        assert_eq!(paint_ui_text(&ui, "hello", UiTextTone::Accent), "hello");
        assert_eq!(format_ui_item(&ui, "line", UiTextTone::Normal), "- line");
        assert_eq!(
            format_ui_key_value(&ui, "Key", "Value", UiTextTone::Normal),
            "Key: Value"
        );
    }

    #[test]
    fn returns_styled_text_in_v2_mode() {
        let ui = v2_ui();
        let text = paint_ui_text(&ui, "hello", UiTextTone::Accent);
        assert!(text.contains("hello"));
        assert!(text.contains("\x1b["));
    }

    #[test]
    fn normal_tone_is_unpainted_even_in_v2() {
        let ui = v2_ui();
        assert_eq!(paint_ui_text(&ui, "hello", UiTextTone::Normal), "hello");
    }

    #[test]
    fn formats_codex_style_headers_and_sections() {
        let ui = v2_ui();
        let header = format_ui_header(&ui, "Codex accounts");
        assert_eq!(header.len(), 2);
        assert!(header[0].contains("Codex accounts"));
        // Divider length: max(8, title.length) dashes.
        assert!(header[1].contains(&"-".repeat("Codex accounts".len())));

        let section = format_ui_section(&ui, "Accounts");
        assert!(section[0].contains("Accounts"));
    }

    #[test]
    fn formats_badges_and_list_items() {
        let ui = v2_ui();
        let badge = format_ui_badge(&ui, "ok", UiBadgeTone::Success);
        assert!(badge.contains("[ok]"));

        let item = format_ui_item(&ui, "1. user@example.com", UiTextTone::Normal);
        assert!(item.contains("1. user@example.com"));
        assert!(item.contains(ui.theme.glyphs.bullet));
    }

    #[test]
    fn maps_quota_severity_with_traffic_light_thresholds() {
        assert_eq!(quota_tone_from_left_percent(70.0), UiTextTone::Success);
        assert_eq!(quota_tone_from_left_percent(35.0), UiTextTone::Warning);
        assert_eq!(quota_tone_from_left_percent(16.0), UiTextTone::Warning);
        assert_eq!(quota_tone_from_left_percent(15.0), UiTextTone::Danger);
        assert_eq!(quota_tone_from_left_percent(0.0), UiTextTone::Danger);
    }

    #[test]
    fn badge_exact_sequences_truecolor_green() {
        let ui = v2_ui();
        assert_eq!(
            format_ui_badge(&ui, "active", UiBadgeTone::Success),
            "\x1b[48;2;20;83;45m\x1b[38;2;220;252;231m\x1b[1m[active]\x1b[0m"
        );
        assert_eq!(
            format_ui_badge(&ui, "error", UiBadgeTone::Danger),
            "\x1b[48;2;127;29;29m\x1b[38;2;254;226;226m\x1b[1m[error]\x1b[0m"
        );
    }

    #[test]
    fn badge_ignores_color_disabled_theme_bug_compatible() {
        // NO_COLOR bug (spec 12 gotcha 8): the badge start sequences are
        // hard-coded and emitted whenever v2 is enabled; only the trailing
        // reset comes from the blanked theme.
        let mut ui = v2_ui();
        ui.theme = create_ui_theme(CreateUiThemeOptions {
            profile: Some(UiColorProfile::Truecolor),
            glyph_mode: Some(UiGlyphMode::Ascii),
            disable_color: Some(true),
            ..Default::default()
        });
        let badge = format_ui_badge(&ui, "ok", UiBadgeTone::Success);
        assert_eq!(
            badge,
            "\x1b[48;2;20;83;45m\x1b[38;2;220;252;231m\x1b[1m[ok]"
        );
        // Regular painted text IS blanked by the disabled theme.
        assert_eq!(paint_ui_text(&ui, "ok", UiTextTone::Success), "ok");
    }

    #[test]
    fn badge_blue_palette_success_uses_blue_variant() {
        let mut ui = v2_ui();
        ui.palette = UiPalette::Blue;
        assert_eq!(
            format_ui_badge(&ui, "ok", UiBadgeTone::Success),
            "\x1b[48;2;30;64;175m\x1b[38;2;219;234;254m\x1b[1m[ok]\x1b[0m"
        );
    }

    #[test]
    fn badge_ansi16_accent_variants() {
        let mut ui = v2_ui();
        ui.color_profile = UiColorProfile::Ansi16;
        ui.accent = UiAccent::Cyan;
        assert_eq!(
            format_ui_badge(&ui, "x", UiBadgeTone::Accent),
            "\x1b[46m\x1b[30m\x1b[1m[x]\x1b[0m"
        );
        ui.accent = UiAccent::Yellow;
        assert_eq!(
            format_ui_badge(&ui, "x", UiBadgeTone::Primary),
            "\x1b[43m\x1b[30m\x1b[1m[x]\x1b[0m"
        );
        assert_eq!(
            format_ui_badge(&ui, "x", UiBadgeTone::Muted),
            "\x1b[100m\x1b[97m\x1b[1m[x]\x1b[0m"
        );
    }
}
