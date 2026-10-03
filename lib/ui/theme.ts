/**
 * Shared terminal theme primitives for legacy and Codex-style TUI rendering.
 */

export type UiColorProfile = "ansi16" | "ansi256" | "truecolor";
export type UiGlyphMode = "ascii" | "unicode" | "auto";
export type UiPalette = "green" | "blue";
export type UiAccent = "green" | "cyan" | "blue" | "yellow";
export type UiColorMode = "auto" | "dark" | "light";
export type ResolvedUiColorMode = "dark" | "light";

interface UiGlyphSet {
	selected: string;
	unselected: string;
	bullet: string;
	check: string;
	cross: string;
}

interface UiThemeColors {
	reset: string;
	dim: string;
	muted: string;
	heading: string;
	primary: string;
	accent: string;
	success: string;
	warning: string;
	danger: string;
	border: string;
	focusBg: string;
	focusText: string;
}

export interface UiTheme {
	profile: UiColorProfile;
	glyphMode: UiGlyphMode;
	/** Resolved background mode ("auto" is never stored here). */
	colorMode: ResolvedUiColorMode;
	glyphs: UiGlyphSet;
	colors: UiThemeColors;
}

const ansi16 = (code: number): string => `\x1b[${code}m`;
const ansi256 = (code: number): string => `\x1b[38;5;${code}m`;
const truecolor = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`;
const ansi256Bg = (code: number): string => `\x1b[48;5;${code}m`;
const truecolorBg = (r: number, g: number, b: number): string => `\x1b[48;2;${r};${g};${b}m`;

/**
 * Resolve a glyph mode, interpreting `"auto"` to choose `"unicode"` or `"ascii"` based on the environment.
 *
 * Safe for concurrent use, performs no filesystem operations (including on Windows), and does not expose or log sensitive tokens.
 *
 * @param mode - The requested glyph mode ("ascii", "unicode", or "auto")
 * @returns `"unicode"` when Unicode is likely safe, `"ascii"` otherwise; if `mode` is not `"auto"`, returns it unchanged
 */
function resolveGlyphMode(mode: UiGlyphMode): Exclude<UiGlyphMode, "auto"> {
	if (mode !== "auto") return mode;
	const isLikelyUnicodeSafe =
		process.env.WT_SESSION !== undefined ||
		process.env.TERM_PROGRAM === "vscode" ||
		process.env.TERM?.toLowerCase().includes("xterm") === true;
	return isLikelyUnicodeSafe ? "unicode" : "ascii";
}

/**
 * Selects a glyph set appropriate for the given glyph mode.
 *
 * This function has no concurrency implications, performs no filesystem I/O (including on Windows), and does not perform any token redaction.
 *
 * @param mode - The resolved glyph mode; `'unicode'` yields Unicode glyphs, otherwise ASCII glyphs
 * @returns The `UiGlyphSet` matching the requested `mode`
 */
function getGlyphs(mode: Exclude<UiGlyphMode, "auto">): UiGlyphSet {
	if (mode === "unicode") {
		return {
			selected: "◆",
			unselected: "○",
			bullet: "•",
			check: "✓",
			cross: "✗",
		};
	}
	return {
		selected: ">",
		unselected: "o",
		bullet: "-",
		check: "+",
		cross: "x",
	};
}

/** Perceived luminance (0.299/0.587/0.114) of the standard 16-color palette. */
const ANSI16_LUMINANCE = [
	0, 38, 75, 113, 15, 53, 90, 192, 128, 76, 150, 226, 29, 105, 179, 255,
] as const;

/**
 * Interpret the `COLORFGBG` env convention (`"<fg>;<bg>"`, sometimes
 * `"<fg>;default;<bg>"`) and report whether the terminal background is light.
 * Returns `undefined` when the variable is absent or cannot be parsed.
 */
function detectLightBackgroundFromEnv(
	env: NodeJS.ProcessEnv,
): boolean | undefined {
	const raw = env.COLORFGBG?.trim();
	if (!raw) return undefined;
	const bgField = raw.split(";").pop()?.trim() ?? "";
	if (!/^\d{1,2}$/.test(bgField)) return undefined;
	const bg = Number.parseInt(bgField, 10);
	const luminance = ANSI16_LUMINANCE[bg];
	if (luminance === undefined) return undefined;
	return luminance >= 128;
}

/**
 * Resolve the effective color mode for a theme.
 *
 * Resolution order:
 *   - `CODEX_TUI_COLOR_MODE` env override (`"auto"`, `"dark"`, or `"light"`)
 *   - the requested `mode` (`"dark"`/`"light"` win outright)
 *   - `COLORFGBG` terminal-background detection
 *   - `"dark"` (preserves the historical dark-on-dark styling by default)
 */
export function resolveUiColorMode(
	mode: UiColorMode = "auto",
	env: NodeJS.ProcessEnv = process.env,
): ResolvedUiColorMode {
	const envValue = env.CODEX_TUI_COLOR_MODE?.trim().toLowerCase();
	const envMode =
		envValue === "dark" || envValue === "light" || envValue === "auto"
			? envValue
			: undefined;
	const requested = envMode ?? mode;
	if (requested !== "auto") return requested;
	return detectLightBackgroundFromEnv(env) === true ? "light" : "dark";
}

/**
 * Selects the ANSI escape sequence for the requested accent color according to the color profile.
 *
 * This function is pure and has no side effects: it is safe for concurrent use, performs no filesystem operations (including on Windows), and does not perform any token redaction.
 *
 * @param profile - The color profile to use (`"truecolor"`, `"ansi256"`, or `"ansi16"`)
 * @param accent - The accent name to resolve (`"green"`, `"cyan"`, `"blue"`, or `"yellow"`)
 * @param mode - The resolved background mode; `"light"` shifts accent colors darker so they stay readable on light terminal backgrounds
 * @returns The escape sequence for the accent color suitable for use as a foreground color
 */
function accentColorForProfile(
	profile: UiColorProfile,
	accent: UiAccent,
	mode: ResolvedUiColorMode,
): string {
	if (mode === "light") {
		switch (profile) {
			case "truecolor":
				switch (accent) {
					case "cyan":
						return truecolor(14, 116, 144);
					case "blue":
						return truecolor(29, 78, 216);
					case "yellow":
						return truecolor(180, 83, 9);
					default:
						return truecolor(21, 128, 61);
				}
			case "ansi256":
				switch (accent) {
					case "cyan":
						return ansi256(31);
					case "blue":
						return ansi256(25);
					case "yellow":
						return ansi256(166);
					default:
						return ansi256(28);
				}
			default:
				switch (accent) {
					case "cyan":
						return ansi16(36);
					case "blue":
						return ansi16(34);
					case "yellow":
						return ansi16(33);
					default:
						return ansi16(32);
				}
		}
	}
	switch (profile) {
		case "truecolor":
			switch (accent) {
				case "cyan":
					return truecolor(34, 211, 238);
				case "blue":
					return truecolor(59, 130, 246);
				case "yellow":
					return truecolor(245, 158, 11);
				default:
					return truecolor(74, 222, 128);
			}
		case "ansi256":
			switch (accent) {
				case "cyan":
					return ansi256(51);
				case "blue":
					return ansi256(75);
				case "yellow":
					return ansi256(214);
				default:
					return ansi256(83);
			}
		default:
			switch (accent) {
				case "cyan":
					return ansi16(96);
				case "blue":
					return ansi16(94);
				case "yellow":
					return ansi16(93);
				default:
					return ansi16(92);
			}
	}
}

/**
 * Produce a set of terminal color tokens and focus/background values appropriate for the given color profile, palette, and accent.
 *
 * This function is safe for concurrent use (no shared mutable state), performs no filesystem operations (including on Windows), and returns color tokens that may contain ANSI escape sequences — treat those sequences as sensitive when logging or emitting to external telemetry and redact them as needed.
 *
 * @param profile - The color capability profile to target (`"ansi16" | "ansi256" | "truecolor"`)
 * @param palette - The UI palette selection that influences primary/success/border colors (`"green" | "blue"`)
 * @param accent - The accent color choice used for the `accent` token (`"green" | "cyan" | "blue" | "yellow"`)
 * @param mode - The resolved background mode; `"light"` darkens colors painted directly on the terminal background while badge/focus colors keep their own dark backgrounds
 * @returns A UiThemeColors object containing resolved color tokens (e.g., `reset`, `dim`, `muted`, `heading`, `primary`, `accent`, `success`, `warning`, `danger`, `border`, `focusBg`, and `focusText`)
 */
function getColors(
	profile: UiColorProfile,
	palette: UiPalette,
	accent: UiAccent,
	mode: ResolvedUiColorMode,
): UiThemeColors {
	const accentColor = accentColorForProfile(profile, accent, mode);
	const isBluePalette = palette === "blue";
	const light = mode === "light";
	switch (profile) {
		case "truecolor": {
			const primary = isBluePalette
				? light
					? truecolor(29, 78, 216)
					: truecolor(96, 165, 250)
				: light
					? truecolor(21, 128, 61)
					: truecolor(74, 222, 128);
			return {
				reset: "\x1b[0m",
				dim: "\x1b[2m",
				muted: light ? truecolor(71, 85, 105) : truecolor(148, 163, 184),
				heading: light ? truecolor(30, 41, 59) : truecolor(240, 253, 244),
				primary,
				accent: accentColor,
				success: primary,
				warning: light ? truecolor(180, 83, 9) : truecolor(245, 158, 11),
				danger: light ? truecolor(185, 28, 28) : truecolor(239, 68, 68),
				border: isBluePalette
					? light
						? truecolor(37, 99, 235)
						: truecolor(59, 130, 246)
					: light
						? truecolor(22, 163, 74)
						: truecolor(34, 197, 94),
				focusBg: isBluePalette ? truecolorBg(37, 99, 235) : truecolorBg(22, 101, 52),
				focusText: truecolor(248, 250, 252),
			};
		}
		case "ansi256": {
			const primary = isBluePalette
				? light
					? ansi256(25)
					: ansi256(75)
				: light
					? ansi256(28)
					: ansi256(83);
			return {
				reset: "\x1b[0m",
				dim: "\x1b[2m",
				muted: light ? ansi256(240) : ansi256(102),
				heading: light ? ansi256(234) : ansi256(255),
				primary,
				accent: accentColor,
				success: primary,
				warning: light ? ansi256(166) : ansi256(214),
				danger: light ? ansi256(160) : ansi256(196),
				border: isBluePalette
					? light
						? ansi256(25)
						: ansi256(27)
					: light
						? ansi256(28)
						: ansi256(40),
				focusBg: isBluePalette ? ansi256Bg(26) : ansi256Bg(28),
				focusText: ansi256(231),
			};
		}
		default: {
			const primary = isBluePalette
				? light
					? ansi16(34)
					: ansi16(94)
				: light
					? ansi16(32)
					: ansi16(92);
			return {
				reset: "\x1b[0m",
				dim: "\x1b[2m",
				muted: light ? ansi16(30) : ansi16(37),
				heading: light ? ansi16(30) : ansi16(97),
				primary,
				accent: accentColor,
				success: primary,
				warning: light ? ansi16(33) : ansi16(93),
				danger: light ? ansi16(31) : ansi16(91),
				border: primary,
				focusBg: isBluePalette ? "\x1b[104m" : "\x1b[102m",
				focusText: "\x1b[30m",
			};
		}
	}
}

/**
 * Decide whether ANSI color output should be suppressed (ui-04).
 *
 * Honors the de-facto conventions:
 *   - NO_COLOR set (to anything) disables color (https://no-color.org)
 *   - FORCE_COLOR overrides: "0"/"false" forces off, any other value forces on
 *   - otherwise, color is off when stdout is not a TTY (piped/redirected)
 *
 * Injectable env/isTTY keep this unit-testable.
 */
export function shouldDisableColor(
	env: NodeJS.ProcessEnv = process.env,
	isTTY: boolean = Boolean(process.stdout?.isTTY),
): boolean {
	const force = (env.FORCE_COLOR ?? "").trim().toLowerCase();
	if (force === "0" || force === "false") return true;
	if (force.length > 0) return false; // explicit force-on wins over TTY/NO_COLOR
	if (typeof env.NO_COLOR === "string") return true;
	return !isTTY;
}

/** Replace every color token with an empty string (color-disabled theme). */
function stripColors(colors: UiThemeColors): UiThemeColors {
	const blanked = {} as Record<keyof UiThemeColors, string>;
	for (const key of Object.keys(colors) as Array<keyof UiThemeColors>) {
		blanked[key] = "";
	}
	return blanked as UiThemeColors;
}

/**
 * Create a UI theme object for terminal rendering.
 *
 * @param options - Optional configuration:
 *   - profile: color profile to use; defaults to `"truecolor"`.
 *   - glyphMode: glyph rendering mode; defaults to `"ascii"`.
 *   - palette: overall palette variant; defaults to `"green"`.
 *   - accent: accent color selection; defaults to `"green"`.
 *   - colorMode: background mode; defaults to `"auto"`, which honors
 *     `CODEX_TUI_COLOR_MODE`, then `COLORFGBG` detection, then `"dark"`.
 *   - disableColor: force the color-stripped theme regardless of env/TTY.
 *   - env: environment override for detection and color gating; defaults to `process.env`.
 * @returns The constructed UiTheme object containing `profile`, `glyphMode`, resolved `colorMode`, `glyphs`, and `colors`.
 *
 * @remarks
 * - Concurrency: creation is pure and side-effect free, safe to call concurrently.
 * - Windows filesystem: theme creation does not access the filesystem and has no platform-specific file behavior.
 * - Token redaction: this function does not handle or emit secrets or sensitive tokens.
 */
export function createUiTheme(options?: {
	profile?: UiColorProfile;
	glyphMode?: UiGlyphMode;
	palette?: UiPalette;
	accent?: UiAccent;
	colorMode?: UiColorMode;
	disableColor?: boolean;
	env?: NodeJS.ProcessEnv;
}): UiTheme {
	const profile = options?.profile ?? "truecolor";
	const glyphMode = options?.glyphMode ?? "ascii";
	const palette = options?.palette ?? "green";
	const accent = options?.accent ?? "green";
	const env = options?.env ?? process.env;
	const resolvedGlyphMode = resolveGlyphMode(glyphMode);
	const colorMode = resolveUiColorMode(options?.colorMode ?? "auto", env);
	const colors = getColors(profile, palette, accent, colorMode);
	// ui-04: honor NO_COLOR / FORCE_COLOR / non-TTY by blanking color tokens. The
	// caller may also force this explicitly (e.g. for snapshot-stable output).
	const disableColor =
		options?.disableColor ??
		shouldDisableColor(env, Boolean(process.stdout?.isTTY));
	return {
		profile,
		glyphMode,
		colorMode,
		glyphs: getGlyphs(resolvedGlyphMode),
		colors: disableColor ? stripColors(colors) : colors,
	};
}
