import { displayWidth, truncateToWidth } from "../lib/ui/display-width.js";

describe("display-width (ui-02)", () => {
	describe("displayWidth", () => {
		it("counts ASCII as 1 column each", () => {
			expect(displayWidth("hello")).toBe(5);
			expect(displayWidth("")).toBe(0);
		});

		it("counts CJK ideographs as 2 columns", () => {
			expect(displayWidth("漢字")).toBe(4); // 2 wide glyphs
			expect(displayWidth("a漢")).toBe(3); // 1 + 2
		});

		it("counts fullwidth and hangul as 2 columns", () => {
			expect(displayWidth("ＡＢ")).toBe(4); // fullwidth A B
			expect(displayWidth("한")).toBe(2);
		});

		it("treats combining marks and ZWJ as zero width", () => {
			// Build from explicit code points (ASCII source) so the zero-width
			// branches are genuinely hit and the test cannot be silently corrupted
			// by an editor normalizing a precomposed glyph on save.
			const combining = `e${String.fromCharCode(0x0301)}`; // e + COMBINING ACUTE ACCENT
			expect(combining).toHaveLength(2);
			expect(displayWidth(combining)).toBe(1);
			const zwj = `a${String.fromCharCode(0x200d)}b`; // a + ZERO WIDTH JOINER + b
			expect(zwj).toHaveLength(3);
			expect(displayWidth(zwj)).toBe(2);
		});

		it("counts emoji pictographs as 2 columns", () => {
			expect(displayWidth(String.fromCodePoint(0x1f600))).toBe(2);
		});

		it("collapses a ZWJ emoji sequence to a single 2-column glyph", () => {
			// 👨‍👩‍👧 = man + ZWJ + woman + ZWJ + girl. A naive per-code-point sum is
			// 2+0+2+0+2 = 6; it renders as one 2-wide glyph.
			const family =
				String.fromCodePoint(0x1f468) +
				String.fromCharCode(0x200d) +
				String.fromCodePoint(0x1f469) +
				String.fromCharCode(0x200d) +
				String.fromCodePoint(0x1f467);
			expect(displayWidth(family)).toBe(2);
		});

		it("counts an emoji + skin-tone modifier as one 2-column glyph", () => {
			// 👍 + medium-dark skin tone modifier (U+1F3FE) → still 2 columns.
			const thumbsUp =
				String.fromCodePoint(0x1f44d) + String.fromCodePoint(0x1f3fe);
			expect(displayWidth(thumbsUp)).toBe(2);
		});

		it("counts a regional-indicator flag pair as one 2-column glyph", () => {
			// 🇺🇸 = REGIONAL INDICATOR U + S → one 2-wide flag, not 4.
			const flag =
				String.fromCodePoint(0x1f1fa) + String.fromCodePoint(0x1f1f8);
			expect(displayWidth(flag)).toBe(2);
			// A lone trailing indicator still counts as one 2-wide glyph.
			expect(displayWidth(String.fromCodePoint(0x1f1fa))).toBe(2);
		});

		it("does NOT collapse a ZWJ between non-emoji wide chars", () => {
			// 漢 + ZWJ + 字: two separate 2-wide CJK glyphs joined by a zero-width
			// control = width 4, NOT 2. The ZWJ fast-path must gate on emoji-ness,
			// not on "both sides are 2 columns".
			const cjkZwj = `漢${String.fromCharCode(0x200d)}字`;
			expect(displayWidth(cjkZwj)).toBe(4);
		});

		it("counts emoji-presentation (U+FE0F) clusters at rendered width 2", () => {
			// Bases that are text-width 1 render at width 2 with the emoji-presentation
			// selector U+FE0F: ☀️ (U+2600), ❤️ (U+2764).
			expect(displayWidth(`${String.fromCodePoint(0x2600)}${String.fromCharCode(0xfe0f)}`)).toBe(2);
			expect(displayWidth(`${String.fromCodePoint(0x2764)}${String.fromCharCode(0xfe0f)}`)).toBe(2);
			// Without FE0F the bare text symbol stays width 1.
			expect(displayWidth(String.fromCodePoint(0x2600))).toBe(1);
		});

		it("counts a keycap sequence (digit + FE0F + U+20E3) as width 2", () => {
			// 1️⃣ = "1" + U+FE0F + U+20E3 (combining enclosing keycap).
			const keycap = `1${String.fromCharCode(0xfe0f)}${String.fromCharCode(0x20e3)}`;
			expect(displayWidth(keycap)).toBe(2);
		});

		it("treats non-Latin combining marks as zero width", () => {
			// Arabic fatha (U+064E), Hebrew point (U+05B0), Thai sara-i (U+0E34).
			expect(displayWidth(`a${String.fromCharCode(0x064e)}`)).toBe(1);
			expect(displayWidth(`a${String.fromCharCode(0x05b0)}`)).toBe(1);
			expect(displayWidth(`a${String.fromCharCode(0x0e34)}`)).toBe(1);
		});
	});

	describe("truncateToWidth", () => {
		it("truncates by columns and never splits a wide glyph", () => {
			// "漢" is 2 cols; with maxWidth 1 it cannot fit, so it is dropped.
			expect(truncateToWidth("漢字", 1)).toEqual({ text: "", width: 0 });
			expect(truncateToWidth("漢字", 2)).toEqual({ text: "漢", width: 2 });
			expect(truncateToWidth("a漢b", 3)).toEqual({ text: "a漢", width: 3 });
		});

		it("returns empty for non-positive width", () => {
			expect(truncateToWidth("anything", 0)).toEqual({ text: "", width: 0 });
		});

		it("keeps full string when it fits", () => {
			expect(truncateToWidth("hi", 10)).toEqual({ text: "hi", width: 2 });
		});

		it("never splits a ZWJ emoji cluster across the boundary", () => {
			// 👨‍👩‍👧 is one 2-wide cluster. At maxWidth 1 it can't fit (dropped whole);
			// at 2 it is kept whole (never half a join).
			const family =
				String.fromCodePoint(0x1f468) +
				String.fromCharCode(0x200d) +
				String.fromCodePoint(0x1f469) +
				String.fromCharCode(0x200d) +
				String.fromCodePoint(0x1f467);
			expect(truncateToWidth(family, 1)).toEqual({ text: "", width: 0 });
			expect(truncateToWidth(family, 2)).toEqual({ text: family, width: 2 });
		});
	});
});
