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
	});
});
