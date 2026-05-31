import { describe, it, expect } from "vitest";
import { createUiTheme, shouldDisableColor } from "../lib/ui/theme.js";

describe("UI theme", () => {
	// These assert ANSI color tokens, so they opt into color explicitly
	// (disableColor:false) — the test env sets NO_COLOR/FORCE_COLOR=0 which would
	// otherwise blank the tokens (ui-04).
	it("uses defaults when options are omitted", () => {
		const theme = createUiTheme({ disableColor: false });
		expect(theme.profile).toBe("truecolor");
		expect(theme.glyphMode).toBe("ascii");
		expect(theme.glyphs.selected.length).toBeGreaterThan(0);
		expect(theme.colors.reset).toBe("\x1b[0m");
		expect(theme.colors.primary).toContain("\x1b[");
		expect(theme.colors.focusBg).toContain("\x1b[");
		expect(theme.colors.focusText).toContain("\x1b[");
	});

	it("uses ansi16 color profile when requested", () => {
		const theme = createUiTheme({ profile: "ansi16", disableColor: false });
		expect(theme.profile).toBe("ansi16");
		expect(theme.colors.accent).toContain("\x1b[");
	});

	it("uses ansi256 color profile when requested", () => {
		const theme = createUiTheme({ profile: "ansi256", disableColor: false });
		expect(theme.profile).toBe("ansi256");
		expect(theme.colors.accent).toContain("38;5;");
	});

	it("supports blue palette and cyan accent overrides", () => {
		const theme = createUiTheme({
			profile: "truecolor",
			palette: "blue",
			accent: "cyan",
			disableColor: false,
		});
		expect(theme.colors.primary).toContain("\x1b[");
		expect(theme.colors.accent).toContain("\x1b[");
		expect(theme.colors.focusBg).toContain("\x1b[");
	});

	it("uses unicode glyph set when explicitly requested", () => {
		const theme = createUiTheme({ glyphMode: "unicode" });
		expect(theme.glyphs.selected).not.toBe(">");
		expect(theme.glyphs.check).not.toBe("+");
	});

	it("keeps ascii glyph set when explicitly requested", () => {
		const theme = createUiTheme({ glyphMode: "ascii" });
		expect(theme.glyphs.selected).toBe(">");
		expect(theme.glyphs.check).toBe("+");
	});

	// ui-04: NO_COLOR / FORCE_COLOR / non-TTY gating.
	describe("color gating (shouldDisableColor)", () => {
		it("disables color when NO_COLOR is set (any value)", () => {
			expect(shouldDisableColor({ NO_COLOR: "" }, true)).toBe(true);
			expect(shouldDisableColor({ NO_COLOR: "1" }, true)).toBe(true);
		});

		it("FORCE_COLOR=0 disables even on a TTY", () => {
			expect(shouldDisableColor({ FORCE_COLOR: "0" }, true)).toBe(true);
		});

		it("FORCE_COLOR (truthy) forces color on, overriding NO_COLOR and non-TTY", () => {
			expect(shouldDisableColor({ FORCE_COLOR: "1", NO_COLOR: "1" }, false)).toBe(false);
		});

		it("disables color when stdout is not a TTY", () => {
			expect(shouldDisableColor({}, false)).toBe(true);
		});

		it("enables color on a plain TTY with no overrides", () => {
			expect(shouldDisableColor({}, true)).toBe(false);
		});

		it("blanks all color tokens when disableColor is true, preserving glyphs", () => {
			const theme = createUiTheme({ disableColor: true });
			expect(theme.colors.reset).toBe("");
			expect(theme.colors.primary).toBe("");
			expect(theme.colors.focusBg).toBe("");
			// glyphs are unaffected by color gating
			expect(theme.glyphs.selected.length).toBeGreaterThan(0);
		});
	});
});
