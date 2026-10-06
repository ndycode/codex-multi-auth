import { describe, it, expect } from "vitest";
import {
	createUiTheme,
	resolveUiColorMode,
	shouldDisableColor,
} from "../lib/ui/theme.js";

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

	it("defaults to the dark color mode", () => {
		const theme = createUiTheme({ disableColor: false, env: {} });
		expect(theme.colorMode).toBe("dark");
	});

	it("uses light-readable colors in light mode without touching focus colors", () => {
		const dark = createUiTheme({
			colorMode: "dark",
			disableColor: false,
			env: {},
		});
		const light = createUiTheme({
			colorMode: "light",
			disableColor: false,
			env: {},
		});
		expect(light.colorMode).toBe("light");
		// Colors painted on the terminal background must differ so they stay
		// readable on light themes (issue #728).
		expect(light.colors.heading).not.toBe(dark.colors.heading);
		expect(light.colors.muted).not.toBe(dark.colors.muted);
		expect(light.colors.primary).not.toBe(dark.colors.primary);
		expect(light.colors.accent).not.toBe(dark.colors.accent);
		expect(light.colors.warning).not.toBe(dark.colors.warning);
		expect(light.colors.danger).not.toBe(dark.colors.danger);
		expect(light.colors.border).not.toBe(dark.colors.border);
		// Pale foreground on the dashboard's own dark badge/focus backgrounds
		// stays identical: those elements bring their own background color.
		expect(light.colors.focusBg).toBe(dark.colors.focusBg);
		expect(light.colors.focusText).toBe(dark.colors.focusText);
	});

	it("light mode darkens on-background text in every color profile", () => {
		for (const profile of ["truecolor", "ansi256", "ansi16"] as const) {
			const dark = createUiTheme({
				profile,
				colorMode: "dark",
				disableColor: false,
				env: {},
			});
			const light = createUiTheme({
				profile,
				colorMode: "light",
				disableColor: false,
				env: {},
			});
			expect(light.colors.heading).not.toBe(dark.colors.heading);
			expect(light.colors.muted).not.toBe(dark.colors.muted);
			expect(light.colors.focusBg).toBe(dark.colors.focusBg);
			expect(light.colors.focusText).toBe(dark.colors.focusText);
		}
	});

	describe("resolveUiColorMode", () => {
		it("returns explicit dark/light modes", () => {
			expect(resolveUiColorMode("dark", {})).toBe("dark");
			expect(resolveUiColorMode("light", {})).toBe("light");
		});

		it("falls back to dark when no signals are present", () => {
			expect(resolveUiColorMode("auto", {})).toBe("dark");
		});

		it("detects a light background from COLORFGBG", () => {
			expect(resolveUiColorMode("auto", { COLORFGBG: "0;15" })).toBe("light");
			expect(resolveUiColorMode("auto", { COLORFGBG: "0;7" })).toBe("light");
			expect(resolveUiColorMode("auto", { COLORFGBG: "12;11" })).toBe(
				"light",
			);
			expect(resolveUiColorMode("auto", { COLORFGBG: "7;0" })).toBe("dark");
			// 8 (bright black, #808080) is a mid gray: dark text reads better
			// than pale text on it, so it resolves as a light background.
			expect(resolveUiColorMode("auto", { COLORFGBG: "7;8" })).toBe(
				"light",
			);
			expect(resolveUiColorMode("auto", { COLORFGBG: "15;9" })).toBe(
				"dark",
			);
		});

		it("ignores malformed COLORFGBG values", () => {
			expect(resolveUiColorMode("auto", { COLORFGBG: "" })).toBe("dark");
			expect(resolveUiColorMode("auto", { COLORFGBG: "default" })).toBe(
				"dark",
			);
			expect(resolveUiColorMode("auto", { COLORFGBG: "0;abc" })).toBe(
				"dark",
			);
			expect(resolveUiColorMode("auto", { COLORFGBG: "0;200" })).toBe(
				"dark",
			);
		});

		it("lets CODEX_TUI_COLOR_MODE override the requested mode and detection", () => {
			expect(
				resolveUiColorMode("dark", { CODEX_TUI_COLOR_MODE: "light" }),
			).toBe("light");
			expect(
				resolveUiColorMode("light", { CODEX_TUI_COLOR_MODE: "DARK" }),
			).toBe("dark");
			expect(
				resolveUiColorMode("dark", {
					CODEX_TUI_COLOR_MODE: "auto",
					COLORFGBG: "0;15",
				}),
			).toBe("light");
			expect(
				resolveUiColorMode("dark", { CODEX_TUI_COLOR_MODE: "bogus" }),
			).toBe("dark");
		});

		it("is honored by createUiTheme", () => {
			const theme = createUiTheme({
				disableColor: false,
				env: { COLORFGBG: "0;15" },
			});
			expect(theme.colorMode).toBe("light");
		});
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
