/**
 * Display-width helpers for terminal layout (ui-02).
 *
 * Terminal alignment math must count *display columns*, not UTF-16 code units.
 * `"漢".length` is 1 but it occupies 2 columns; an emoji like "😀" is 2 columns
 * but length 2 (surrogate pair) — coincidentally right — while a combining mark
 * occupies 0 columns. Using `.length` for padding/truncation therefore misaligns
 * CJK/emoji content.
 *
 * This is intentionally a focused implementation covering the common cases
 * (wide East-Asian ranges + zero-width combining marks + variation selectors),
 * not a full ICU east-asian-width table. It is dependency-free and pure.
 */

/** Returns the number of terminal columns a single code point occupies (0, 1, or 2). */
function codePointWidth(cp: number): number {
	// Zero-width: combining marks, zero-width space/joiner, variation selectors.
	if (
		cp === 0x200b || // zero-width space
		cp === 0x200d || // zero-width joiner
		(cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
		(cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
		(cp >= 0x1ab0 && cp <= 0x1aff) || // combining diacritical marks extended
		(cp >= 0x20d0 && cp <= 0x20ff) // combining marks for symbols
	) {
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

/** Display width of a string in terminal columns (ignores ANSI; pass stripped text). */
export function displayWidth(text: string): number {
	let width = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0);
		if (cp === undefined) continue;
		width += codePointWidth(cp);
	}
	return width;
}

/**
 * Truncate `text` so its display width does not exceed `maxWidth`, returning the
 * kept prefix and its actual display width. Never splits a wide glyph across the
 * boundary (a 2-col glyph that would overflow is dropped).
 */
export function truncateToWidth(
	text: string,
	maxWidth: number,
): { text: string; width: number } {
	if (maxWidth <= 0) return { text: "", width: 0 };
	let width = 0;
	let out = "";
	for (const ch of text) {
		const cp = ch.codePointAt(0);
		if (cp === undefined) continue;
		const w = codePointWidth(cp);
		if (width + w > maxWidth) break;
		out += ch;
		width += w;
	}
	return { text: out, width };
}
