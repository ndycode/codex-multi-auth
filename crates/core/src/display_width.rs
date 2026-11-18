//! Port of `lib/ui/display-width.ts` (ui-02): terminal display-column math.
//!
//! Terminal alignment must count *display columns*, not UTF-16 units or bytes.
//! This is a focused, dependency-free implementation covering the common cases:
//! wide East-Asian ranges, zero-width combining marks across Latin/Cyrillic/
//! Hebrew/Arabic/Syriac/Thai/Lao scripts, variation selectors, and grapheme
//! clustering for ZWJ emoji sequences, emoji skin-tone modifiers, and
//! regional-indicator flag pairs. It is not a full ICU east-asian-width table.
//!
//! IMPORTANT: the width TABLES and the bespoke cluster algorithm are ported
//! VERBATIM from the TS source. Do NOT substitute the `unicode-width` crate's
//! tables or UAX#29 segmentation — either would shift every table column and
//! menu row rendered by the CLI (ARCHITECTURE §5.3 / spec 12 §2).

/// Zero-width: combining marks, joiners, variation selectors across scripts.
fn is_zero_width_code_point(cp: u32) -> bool {
    cp == 0x200b // zero-width space
        || cp == 0x200c // zero-width non-joiner
        || cp == 0x200d // zero-width joiner
        || cp == 0xfeff // zero-width no-break space (BOM)
        || (0x0300..=0x036f).contains(&cp) // combining diacritical marks
        || (0x0483..=0x0489).contains(&cp) // Cyrillic combining
        || (0x0591..=0x05bd).contains(&cp) // Hebrew points
        || cp == 0x05bf
        || cp == 0x05c1
        || cp == 0x05c2
        || cp == 0x05c4
        || cp == 0x05c5
        || cp == 0x05c7
        || (0x0610..=0x061a).contains(&cp) // Arabic
        || (0x064b..=0x065f).contains(&cp)
        || cp == 0x0670
        || (0x06d6..=0x06dc).contains(&cp)
        || (0x06df..=0x06e4).contains(&cp)
        || (0x06e7..=0x06e8).contains(&cp)
        || (0x06ea..=0x06ed).contains(&cp)
        || cp == 0x0711 // Syriac
        || (0x0730..=0x074a).contains(&cp)
        || cp == 0x0e31 // Thai
        || (0x0e34..=0x0e3a).contains(&cp)
        || (0x0e47..=0x0e4e).contains(&cp)
        || (0x0eb1..=0x0ebc).contains(&cp) // Lao (subset)
        || (0x1ab0..=0x1aff).contains(&cp) // combining diacritical marks extended
        || (0x1dc0..=0x1dff).contains(&cp) // combining diacritical marks supplement
        || (0x20d0..=0x20ff).contains(&cp) // combining marks for symbols
        || (0xfe00..=0xfe0f).contains(&cp) // variation selectors
        || (0xfe20..=0xfe2f).contains(&cp) // combining half marks
        || (0xe0100..=0xe01ef).contains(&cp) // variation selectors supplement
}

/// Emoji skin-tone modifiers attach to the preceding base emoji (zero added width).
fn is_emoji_modifier(cp: u32) -> bool {
    (0x1f3fb..=0x1f3ff).contains(&cp)
}

/// Regional indicator symbols (U+1F1E6–U+1F1FF) pair into a single 2-wide flag.
fn is_regional_indicator(cp: u32) -> bool {
    (0x1f1e6..=0x1f1ff).contains(&cp)
}

/// Emoji / pictographic code points that participate in ZWJ sequences. This is
/// deliberately the emoji blocks only (NOT every 2-wide code point): a ZWJ
/// between wide CJK text (e.g. 漢‍字) must NOT collapse — those are two
/// separate 2-wide glyphs, so gating on emoji-ness keeps that width at 4.
fn is_emoji_base(cp: u32) -> bool {
    (0x1f300..=0x1faff).contains(&cp) // misc pictographs, emoji, symbols & pictographs ext
        || (0x2600..=0x27bf).contains(&cp) // misc symbols + dingbats
        || (0x1f000..=0x1f0ff).contains(&cp) // mahjong/domino/playing cards
        || cp == 0x2764 // heavy black heart (common ZWJ component)
}

/// Returns the number of terminal columns a single code point occupies (0, 1, or 2).
fn code_point_width(cp: u32) -> usize {
    if is_zero_width_code_point(cp) {
        return 0;
    }
    // Wide (2-column) ranges: the common CJK + fullwidth + emoji blocks.
    if (0x1100..=0x115f).contains(&cp) // Hangul Jamo
        || (0x2e80..=0x303e).contains(&cp) // CJK radicals, Kangxi
        || (0x3041..=0x33ff).contains(&cp) // Hiragana, Katakana, CJK symbols
        || (0x3400..=0x4dbf).contains(&cp) // CJK Ext A
        || (0x4e00..=0x9fff).contains(&cp) // CJK Unified Ideographs
        || (0xa000..=0xa4cf).contains(&cp) // Yi
        || (0xac00..=0xd7a3).contains(&cp) // Hangul syllables
        || (0xf900..=0xfaff).contains(&cp) // CJK compatibility ideographs
        || (0xfe30..=0xfe4f).contains(&cp) // CJK compatibility forms
        || (0xff00..=0xff60).contains(&cp) // Fullwidth forms
        || (0xffe0..=0xffe6).contains(&cp) // Fullwidth signs
        || (0x1f300..=0x1faff).contains(&cp) // emoji & pictographs
        || (0x20000..=0x3fffd).contains(&cp)
    // CJK Ext B+
    {
        return 2;
    }
    1
}

/// Advance through a grapheme cluster starting at code-point index `i` in `cps`,
/// returning `(cluster_width, next_index)`. This collapses the three cluster
/// shapes that a naive per-code-point sum overcounts:
///   - ZWJ sequences (e.g. 👨‍👩‍👧): the whole join is one 2-wide glyph.
///   - emoji + skin-tone modifier / variation selector: the modifier adds 0.
///   - regional-indicator pairs (flags): two RIs render as one 2-wide glyph.
fn cluster_width_at(cps: &[u32], i: usize) -> (usize, usize) {
    let Some(&cp) = cps.get(i) else {
        return (0, i + 1);
    };

    // Regional-indicator flag: consume a pair as a single width-2 glyph.
    if is_regional_indicator(cp) {
        if let Some(&next) = cps.get(i + 1)
            && is_regional_indicator(next)
        {
            return (2, i + 2);
        }
        return (2, i + 1);
    }

    let mut width = code_point_width(cp);
    let mut j = i + 1;
    // Absorb trailing modifiers / combining marks / ZWJ-joined code points so
    // the whole cluster counts as the width of its leading glyph.
    while j < cps.len() {
        let nxt = cps[j];
        if nxt == 0x200d {
            // ZWJ only forms a single rendered glyph when it joins emoji (e.g.
            // 👨‍👩‍👧). For a ZWJ between non-emoji it is just a zero-width control
            // and the following code point is its own cluster, so only absorb
            // the joined code point when BOTH the leading glyph and the joined
            // one are emoji/pictographic. Otherwise stop and let the joiner
            // count as 0 and the next char count on its own.
            if is_emoji_base(cp)
                && let Some(&joined) = cps.get(j + 1)
                && is_emoji_base(joined)
            {
                // Consume the ZWJ and the joined emoji (adds no extra width).
                j += 2;
                continue;
            }
            break;
        }
        // U+FE0F (variation selector-16) requests EMOJI presentation, which
        // renders at full width 2 even for bases that are otherwise text-width
        // 1 (e.g. ☀️ U+2600, ❤️ U+2764). U+20E3 (combining enclosing keycap)
        // forms keycap emoji like 1️⃣ / #️⃣, also width 2. Promote accordingly.
        if nxt == 0xfe0f || nxt == 0x20e3 {
            width = 2;
            j += 1;
            continue;
        }
        if is_zero_width_code_point(nxt) || is_emoji_modifier(nxt) {
            j += 1;
            continue;
        }
        break;
    }
    (width, j)
}

/// Display width of a string in terminal columns (ignores ANSI; pass stripped text).
pub fn display_width(text: &str) -> usize {
    let cps: Vec<u32> = text.chars().map(|c| c as u32).collect();
    let mut width = 0usize;
    let mut i = 0usize;
    while i < cps.len() {
        let (w, next) = cluster_width_at(&cps, i);
        width += w;
        i = next;
    }
    width
}

/// Result of [`truncate_to_width`]: the kept prefix and its actual display width.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TruncateResult {
    pub text: String,
    pub width: usize,
}

/// Truncate `text` so its display width does not exceed `max_width`, returning
/// the kept prefix and its actual display width. Never splits a wide glyph or a
/// grapheme cluster (ZWJ sequence / flag / emoji+modifier) across the boundary.
///
/// The TS signature accepts any number and returns empty for `maxWidth <= 0`;
/// here the parameter is unsigned, so callers clamp negatives to 0 first
/// (`0` yields the same empty result).
pub fn truncate_to_width(text: &str, max_width: usize) -> TruncateResult {
    if max_width == 0 {
        return TruncateResult {
            text: String::new(),
            width: 0,
        };
    }
    let chars: Vec<char> = text.chars().collect();
    let cps: Vec<u32> = chars.iter().map(|&c| c as u32).collect();
    let mut width = 0usize;
    let mut out = String::new();
    let mut i = 0usize;
    while i < cps.len() {
        let (w, next) = cluster_width_at(&cps, i);
        if width + w > max_width {
            break;
        }
        out.extend(chars[i..next.min(chars.len())].iter());
        width += w;
        i = next;
    }
    TruncateResult { text: out, width }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(cps: &[u32]) -> String {
        cps.iter()
            .map(|&cp| char::from_u32(cp).expect("valid code point"))
            .collect()
    }

    // === displayWidth (ported from test/display-width.test.ts) ===

    #[test]
    fn counts_ascii_as_1_column_each() {
        assert_eq!(display_width("hello"), 5);
        assert_eq!(display_width(""), 0);
    }

    #[test]
    fn counts_cjk_ideographs_as_2_columns() {
        assert_eq!(display_width("漢字"), 4); // 2 wide glyphs
        assert_eq!(display_width("a漢"), 3); // 1 + 2
    }

    #[test]
    fn counts_fullwidth_and_hangul_as_2_columns() {
        assert_eq!(display_width("ＡＢ"), 4); // fullwidth A B
        assert_eq!(display_width("한"), 2);
    }

    #[test]
    fn treats_combining_marks_and_zwj_as_zero_width() {
        let combining = s(&[0x65, 0x0301]); // e + COMBINING ACUTE ACCENT
        assert_eq!(display_width(&combining), 1);
        let zwj = s(&[0x61, 0x200d, 0x62]); // a + ZERO WIDTH JOINER + b
        assert_eq!(display_width(&zwj), 2);
    }

    #[test]
    fn counts_emoji_pictographs_as_2_columns() {
        assert_eq!(display_width(&s(&[0x1f600])), 2);
    }

    #[test]
    fn collapses_a_zwj_emoji_sequence_to_a_single_2_column_glyph() {
        // 👨‍👩‍👧 = man + ZWJ + woman + ZWJ + girl. A naive per-code-point sum is
        // 2+0+2+0+2 = 6; it renders as one 2-wide glyph.
        let family = s(&[0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467]);
        assert_eq!(display_width(&family), 2);
    }

    #[test]
    fn counts_an_emoji_plus_skin_tone_modifier_as_one_2_column_glyph() {
        // 👍 + medium-dark skin tone modifier (U+1F3FE) -> still 2 columns.
        let thumbs_up = s(&[0x1f44d, 0x1f3fe]);
        assert_eq!(display_width(&thumbs_up), 2);
    }

    #[test]
    fn counts_a_regional_indicator_flag_pair_as_one_2_column_glyph() {
        // 🇺🇸 = REGIONAL INDICATOR U + S -> one 2-wide flag, not 4.
        let flag = s(&[0x1f1fa, 0x1f1f8]);
        assert_eq!(display_width(&flag), 2);
        // A lone trailing indicator still counts as one 2-wide glyph.
        assert_eq!(display_width(&s(&[0x1f1fa])), 2);
    }

    #[test]
    fn does_not_collapse_a_zwj_between_non_emoji_wide_chars() {
        // 漢 + ZWJ + 字: two separate 2-wide CJK glyphs joined by a zero-width
        // control = width 4, NOT 2. The ZWJ fast-path must gate on emoji-ness,
        // not on "both sides are 2 columns".
        let cjk_zwj = format!("漢{}字", s(&[0x200d]));
        assert_eq!(display_width(&cjk_zwj), 4);
    }

    #[test]
    fn counts_emoji_presentation_fe0f_clusters_at_rendered_width_2() {
        // Bases that are text-width 1 render at width 2 with the
        // emoji-presentation selector U+FE0F: ☀️ (U+2600), ❤️ (U+2764).
        assert_eq!(display_width(&s(&[0x2600, 0xfe0f])), 2);
        assert_eq!(display_width(&s(&[0x2764, 0xfe0f])), 2);
        // Without FE0F the bare text symbol stays width 1.
        assert_eq!(display_width(&s(&[0x2600])), 1);
    }

    #[test]
    fn counts_a_keycap_sequence_as_width_2() {
        // 1️⃣ = "1" + U+FE0F + U+20E3 (combining enclosing keycap).
        let keycap = s(&[0x31, 0xfe0f, 0x20e3]);
        assert_eq!(display_width(&keycap), 2);
    }

    #[test]
    fn treats_non_latin_combining_marks_as_zero_width() {
        // Arabic fatha (U+064E), Hebrew point (U+05B0), Thai sara-i (U+0E34).
        assert_eq!(display_width(&s(&[0x61, 0x064e])), 1);
        assert_eq!(display_width(&s(&[0x61, 0x05b0])), 1);
        assert_eq!(display_width(&s(&[0x61, 0x0e34])), 1);
    }

    // === truncateToWidth ===

    #[test]
    fn truncates_by_columns_and_never_splits_a_wide_glyph() {
        // "漢" is 2 cols; with max_width 1 it cannot fit, so it is dropped.
        assert_eq!(
            truncate_to_width("漢字", 1),
            TruncateResult {
                text: String::new(),
                width: 0
            }
        );
        assert_eq!(
            truncate_to_width("漢字", 2),
            TruncateResult {
                text: "漢".to_string(),
                width: 2
            }
        );
        assert_eq!(
            truncate_to_width("a漢b", 3),
            TruncateResult {
                text: "a漢".to_string(),
                width: 3
            }
        );
    }

    #[test]
    fn returns_empty_for_non_positive_width() {
        assert_eq!(
            truncate_to_width("anything", 0),
            TruncateResult {
                text: String::new(),
                width: 0
            }
        );
    }

    #[test]
    fn keeps_full_string_when_it_fits() {
        assert_eq!(
            truncate_to_width("hi", 10),
            TruncateResult {
                text: "hi".to_string(),
                width: 2
            }
        );
    }

    #[test]
    fn never_splits_a_zwj_emoji_cluster_across_the_boundary() {
        // 👨‍👩‍👧 is one 2-wide cluster. At max_width 1 it can't fit (dropped
        // whole); at 2 it is kept whole (never half a join).
        let family = s(&[0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467]);
        assert_eq!(
            truncate_to_width(&family, 1),
            TruncateResult {
                text: String::new(),
                width: 0
            }
        );
        assert_eq!(
            truncate_to_width(&family, 2),
            TruncateResult {
                text: family.clone(),
                width: 2
            }
        );
    }
}
