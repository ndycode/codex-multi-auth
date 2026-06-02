/**
 * Display-width helpers for terminal layout (ui-02).
 *
 * Terminal alignment math must count *display columns*, not UTF-16 code units.
 * `"漢".length` is 1 but it occupies 2 columns; an emoji like "😀" is 2 columns
 * but length 2 (surrogate pair) — coincidentally right — while a combining mark
 * occupies 0 columns. Using `.length` for padding/truncation therefore misaligns
 * CJK/emoji content.
 *
 * This is a focused, dependency-free implementation covering the common cases:
 * wide East-Asian ranges, zero-width combining marks across Latin/Cyrillic/
 * Hebrew/Arabic/Syriac/Thai/Lao scripts, variation selectors, and grapheme
 * clustering for ZWJ emoji sequences, emoji skin-tone modifiers, and
 * regional-indicator flag pairs. It is not a full ICU east-asian-width table.
 */

/** Zero-width: combining marks, joiners, variation selectors across scripts. */
function isZeroWidthCodePoint(cp: number): boolean {
	return (
		cp === 0x200b || // zero-width space
		cp === 0x200c || // zero-width non-joiner
		cp === 0x200d || // zero-width joiner
		cp === 0xfeff || // zero-width no-break space (BOM)
		(cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
		(cp >= 0x0483 && cp <= 0x0489) || // Cyrillic combining
		(cp >= 0x0591 && cp <= 0x05bd) || // Hebrew points
		cp === 0x05bf ||
		cp === 0x05c1 ||
		cp === 0x05c2 ||
		cp === 0x05c4 ||
		cp === 0x05c5 ||
		cp === 0x05c7 ||
		(cp >= 0x0610 && cp <= 0x061a) || // Arabic
		(cp >= 0x064b && cp <= 0x065f) ||
		cp === 0x0670 ||
		(cp >= 0x06d6 && cp <= 0x06dc) ||
		(cp >= 0x06df && cp <= 0x06e4) ||
		(cp >= 0x06e7 && cp <= 0x06e8) ||
		(cp >= 0x06ea && cp <= 0x06ed) ||
		cp === 0x0711 || // Syriac
		(cp >= 0x0730 && cp <= 0x074a) ||
		cp === 0x0e31 || // Thai
		(cp >= 0x0e34 && cp <= 0x0e3a) ||
		(cp >= 0x0e47 && cp <= 0x0e4e) ||
		(cp >= 0x0eb1 && cp <= 0x0ebc) || // Lao (subset)
		(cp >= 0x1ab0 && cp <= 0x1aff) || // combining diacritical marks extended
		(cp >= 0x1dc0 && cp <= 0x1dff) || // combining diacritical marks supplement
		(cp >= 0x20d0 && cp <= 0x20ff) || // combining marks for symbols
		(cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
		(cp >= 0xfe20 && cp <= 0xfe2f) || // combining half marks
		(cp >= 0xe0100 && cp <= 0xe01ef) // variation selectors supplement
	);
}

/** Emoji skin-tone modifiers attach to the preceding base emoji (zero added width). */
function isEmojiModifier(cp: number): boolean {
	return cp >= 0x1f3fb && cp <= 0x1f3ff;
}

/** Regional indicator symbols (U+1F1E6–U+1F1FF) pair into a single 2-wide flag. */
function isRegionalIndicator(cp: number): boolean {
	return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

/**
 * Emoji / pictographic code points that participate in ZWJ sequences. This is
 * deliberately the emoji blocks only (NOT every 2-wide code point): a ZWJ
 * between wide CJK text (e.g. 漢‍字) must NOT collapse — those are two
 * separate 2-wide glyphs, so gating on emoji-ness keeps that width at 4.
 */
function isEmojiBase(cp: number): boolean {
	return (
		(cp >= 0x1f300 && cp <= 0x1faff) || // misc pictographs, emoji, symbols & pictographs ext
		(cp >= 0x2600 && cp <= 0x27bf) || // misc symbols + dingbats
		(cp >= 0x1f000 && cp <= 0x1f0ff) || // mahjong/domino/playing cards
		cp === 0x2764 // heavy black heart (common ZWJ component)
	);
}

/** Returns the number of terminal columns a single code point occupies (0, 1, or 2). */
function codePointWidth(cp: number): number {
	if (isZeroWidthCodePoint(cp)) {
		return 0;
	}
	// Wide (2-column) ranges: the common CJK + fullwidth + emoji blocks.
	if (
		(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
		(cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi
		(cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK symbols
		(cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
		(cp >= 0xa000 && cp <= 0xa4cf) || // Yi
		(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
		(cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
		(cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
		(cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
		(cp >= 0x1f300 && cp <= 0x1faff) || // emoji & pictographs
		(cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
	) {
		return 2;
	}
	return 1;
}

/**
 * Advance through a grapheme cluster starting at code-point index `i` in `cps`,
 * returning [clusterWidth, nextIndex]. This collapses the three cluster shapes
 * that a naive per-code-point sum overcounts:
 *   - ZWJ sequences (e.g. 👨‍👩‍👧): the whole join is one 2-wide glyph.
 *   - emoji + skin-tone modifier / variation selector: the modifier adds 0.
 *   - regional-indicator pairs (flags): two RIs render as one 2-wide glyph.
 */
function clusterWidthAt(cps: number[], i: number): [number, number] {
	const cp = cps[i];
	if (cp === undefined) return [0, i + 1];

	// Regional-indicator flag: consume a pair as a single width-2 glyph.
	if (isRegionalIndicator(cp)) {
		const next = cps[i + 1];
		if (next !== undefined && isRegionalIndicator(next)) {
			return [2, i + 2];
		}
		return [2, i + 1];
	}

	let width = codePointWidth(cp);
	let j = i + 1;
	// Absorb trailing modifiers / combining marks / ZWJ-joined code points so the
	// whole cluster counts as the width of its leading glyph.
	for (; j < cps.length; j += 1) {
		const nxt = cps[j];
		if (nxt === undefined) break;
		if (nxt === 0x200d) {
			// ZWJ only forms a single rendered glyph when it joins emoji (e.g.
			// 👨‍👩‍👧). For a ZWJ between non-emoji it is just a zero-width control and
			// the following code point is its own cluster, so only absorb the joined
			// code point when BOTH the leading glyph and the joined one are wide
			// (emoji/pictographic). Otherwise stop and let the joiner count as 0 and
			// the next char count on its own.
			const joined = cps[j + 1];
			if (isEmojiBase(cp) && joined !== undefined && isEmojiBase(joined)) {
				j += 1; // consume the ZWJ and the joined emoji (adds no extra width)
				continue;
			}
			break;
		}
		// U+FE0F (variation selector-16) requests EMOJI presentation, which renders
		// at full width 2 even for bases that are otherwise text-width 1 (e.g. ☀️
		// U+2600, ❤️ U+2764). U+20E3 (combining enclosing keycap) forms keycap
		// emoji like 1️⃣ / #️⃣, also width 2. Promote the cluster accordingly.
		if (nxt === 0xfe0f || nxt === 0x20e3) {
			width = 2;
			continue;
		}
		if (isZeroWidthCodePoint(nxt) || isEmojiModifier(nxt)) {
			continue;
		}
		break;
	}
	return [width, j];
}

/** Display width of a string in terminal columns (ignores ANSI; pass stripped text). */
export function displayWidth(text: string): number {
	const cps: number[] = [];
	for (const ch of text) {
		const cp = ch.codePointAt(0);
		if (cp !== undefined) cps.push(cp);
	}
	let width = 0;
	let i = 0;
	while (i < cps.length) {
		const [w, next] = clusterWidthAt(cps, i);
		width += w;
		i = next;
	}
	return width;
}

/**
 * Truncate `text` so its display width does not exceed `maxWidth`, returning the
 * kept prefix and its actual display width. Never splits a wide glyph or a
 * grapheme cluster (ZWJ sequence / flag / emoji+modifier) across the boundary.
 */
export function truncateToWidth(
	text: string,
	maxWidth: number,
): { text: string; width: number } {
	if (maxWidth <= 0) return { text: "", width: 0 };
	const chars = [...text];
	const cps = chars.map((ch) => ch.codePointAt(0) ?? 0);
	let width = 0;
	let out = "";
	let i = 0;
	while (i < cps.length) {
		const [w, next] = clusterWidthAt(cps, i);
		if (width + w > maxWidth) break;
		out += chars.slice(i, next).join("");
		width += w;
		i = next;
	}
	return { text: out, width };
}
