import { describe, it, expect } from "vitest";
import { createUiTheme } from "../lib/ui/theme.js";

describe("UI theme", () => {
	it("uses defaults when options are omitted", () => {
		const theme = createUiTheme();
		expect(theme.profile).toBe("truecolor");
		expect(theme.glyphMode).toBe("ascii");
		expect(theme.glyphs.selected.length).toBeGreaterThan(0);
		expect(theme.colors.reset).toBe("\x1b[0m");
	});

	it("uses ansi16 color profile when requested", () => {
		const theme = createUiTheme({ profile: "ansi16" });
		expect(theme.profile).toBe("ansi16");
		expect(theme.colors.accent).toContain("\x1b[");
	});

	it("uses ansi256 color profile when requested", () => {
		const theme = createUiTheme({ profile: "ansi256" });
		expect(theme.profile).toBe("ansi256");
		expect(theme.colors.accent).toContain("38;5;");
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
});

