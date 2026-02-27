import type { UiRuntimeOptions } from "./runtime.js";

export type UiTextTone =
	| "primary"
	| "heading"
	| "accent"
	| "muted"
	| "success"
	| "warning"
	| "danger"
	| "normal";

const TONE_TO_COLOR: Record<UiTextTone, keyof UiRuntimeOptions["theme"]["colors"] | null> = {
	primary: "primary",
	heading: "heading",
	accent: "accent",
	muted: "muted",
	success: "success",
	warning: "warning",
	danger: "danger",
	normal: null,
};

/**
 * Compute ANSI start/end sequences for a badge styled to a given tone.
 *
 * @param ui - Runtime options that influence palette, accent, color profile, and theme reset. Concurrency: safe for concurrent reads of `ui` (no mutation). Windows terminals may approximate colors depending on host support. Tokens are not modified or redacted by this function.
 * @param tone - Badge tone to style; one of "primary", "accent", "muted", "success", "warning", or "danger".
 * @returns An object with `start` set to the opening ANSI/escape sequence for the badge and `end` set to the theme's reset sequence.
function badgeStyleForTone(
	ui: UiRuntimeOptions,
	tone: Exclude<UiTextTone, "normal" | "heading">,
): { start: string; end: string } {
	const end = ui.theme.colors.reset;
	const isBlue = ui.palette === "blue";
	const accent = ui.accent;
	if (ui.colorProfile === "truecolor") {
		const accentStart = (() => {
			if (accent === "cyan") return "\x1b[48;2;8;89;106m\x1b[38;2;224;242;254m\x1b[1m";
			if (accent === "blue") return "\x1b[48;2;30;64;175m\x1b[38;2;219;234;254m\x1b[1m";
			if (accent === "yellow") return "\x1b[48;2;120;53;15m\x1b[38;2;255;247;237m\x1b[1m";
			return "\x1b[48;2;20;83;45m\x1b[38;2;220;252;231m\x1b[1m";
		})();
		const successStart = isBlue
			? "\x1b[48;2;30;64;175m\x1b[38;2;219;234;254m\x1b[1m"
			: "\x1b[48;2;20;83;45m\x1b[38;2;220;252;231m\x1b[1m";
		switch (tone) {
			case "primary":
			case "accent":
				return { start: accentStart, end };
			case "success":
				return { start: successStart, end };
			case "warning":
				return { start: "\x1b[48;2;120;53;15m\x1b[38;2;255;247;237m\x1b[1m", end };
			case "danger":
				return { start: "\x1b[48;2;127;29;29m\x1b[38;2;254;226;226m\x1b[1m", end };
			case "muted":
				return { start: "\x1b[48;2;51;65;85m\x1b[38;2;226;232;240m\x1b[1m", end };
		}
	}

	if (ui.colorProfile === "ansi256") {
		const accentStart = (() => {
			if (accent === "cyan") return "\x1b[48;5;23m\x1b[38;5;159m\x1b[1m";
			if (accent === "blue") return "\x1b[48;5;19m\x1b[38;5;153m\x1b[1m";
			if (accent === "yellow") return "\x1b[48;5;94m\x1b[38;5;230m\x1b[1m";
			return "\x1b[48;5;22m\x1b[38;5;157m\x1b[1m";
		})();
		const successStart = isBlue
			? "\x1b[48;5;19m\x1b[38;5;153m\x1b[1m"
			: "\x1b[48;5;22m\x1b[38;5;157m\x1b[1m";
		switch (tone) {
			case "primary":
			case "accent":
				return { start: accentStart, end };
			case "success":
				return { start: successStart, end };
			case "warning":
				return { start: "\x1b[48;5;94m\x1b[38;5;230m\x1b[1m", end };
			case "danger":
				return { start: "\x1b[48;5;88m\x1b[38;5;224m\x1b[1m", end };
			case "muted":
				return { start: "\x1b[48;5;240m\x1b[38;5;255m\x1b[1m", end };
		}
	}

	const accentStart = (() => {
		if (accent === "cyan") return "\x1b[46m\x1b[30m\x1b[1m";
		if (accent === "blue") return "\x1b[44m\x1b[97m\x1b[1m";
		if (accent === "yellow") return "\x1b[43m\x1b[30m\x1b[1m";
		return "\x1b[42m\x1b[30m\x1b[1m";
	})();
	const successStart = isBlue ? "\x1b[44m\x1b[97m\x1b[1m" : "\x1b[42m\x1b[30m\x1b[1m";
	switch (tone) {
		case "primary":
		case "accent":
			return { start: accentStart, end };
		case "success":
			return { start: successStart, end };
		case "warning":
			return { start: "\x1b[43m\x1b[30m\x1b[1m", end };
		case "danger":
			return { start: "\x1b[41m\x1b[97m\x1b[1m", end };
		case "muted":
			return { start: "\x1b[100m\x1b[97m\x1b[1m", end };
	}
}

/**
 * Apply UI color styling to `text` based on `tone` when v2 styling is enabled.
 *
 * This function is thread-safe and has no side effects; it does not access the filesystem. On Windows terminals color escape sequences may be ignored by older consoles. Callers must ensure any sensitive tokens in `text` are redacted before passing them to this function.
 *
 * @param ui - Runtime UI options containing `v2Enabled` and `theme.colors` mappings used for styling
 * @param text - The text to style
 * @param tone - The text tone to apply; if the tone maps to no color or v2 is disabled, the original `text` is returned
 * @returns The input `text` wrapped with the configured color start sequence and the reset sequence, or the original `text` when styling is not applied
 */
export function paintUiText(ui: UiRuntimeOptions, text: string, tone: UiTextTone = "normal"): string {
	if (!ui.v2Enabled) return text;
	const colorKey = TONE_TO_COLOR[tone];
	if (!colorKey) return text;
	return `${ui.theme.colors[colorKey]}${text}${ui.theme.colors.reset}`;
}

export function formatUiHeader(ui: UiRuntimeOptions, title: string): string[] {
	if (!ui.v2Enabled) return [title];
	const divider = "-".repeat(Math.max(8, title.length));
	return [
		paintUiText(ui, title, "heading"),
		paintUiText(ui, divider, "muted"),
	];
}

export function formatUiSection(ui: UiRuntimeOptions, title: string): string[] {
	if (!ui.v2Enabled) return [title];
	return [paintUiText(ui, title, "accent")];
}

export function formatUiItem(
	ui: UiRuntimeOptions,
	text: string,
	tone: UiTextTone = "normal",
): string {
	if (!ui.v2Enabled) return `- ${text}`;
	const bullet = paintUiText(ui, ui.theme.glyphs.bullet, "muted");
	return `${bullet} ${paintUiText(ui, text, tone)}`;
}

export function formatUiKeyValue(
	ui: UiRuntimeOptions,
	key: string,
	value: string,
	valueTone: UiTextTone = "normal",
): string {
	if (!ui.v2Enabled) return `${key}: ${value}`;
	const keyText = paintUiText(ui, `${key}:`, "muted");
	const valueText = paintUiText(ui, value, valueTone);
	return `${keyText} ${valueText}`;
}

/**
 * Format a bracketed badge label using the UI runtime's styling when available.
 *
 * When the UI's v2 styling is disabled this returns a plain "[label]" string;
 * otherwise the returned string includes start/end styling sequences appropriate
 * for the runtime's color profile and palette.
 *
 * Concurrency: pure and side-effect free (safe to call from concurrent contexts).
 * Windows filesystem: output uses printable characters and ANSI sequences; consumers
 * should ensure terminal support on Windows terminals.
 * Token redaction: this function does not perform token redaction — redact `label`
 * before calling if it may contain sensitive data.
 *
 * @param ui - Runtime options controlling palette, color profile, and v2 enablement
 * @param label - The badge text to wrap in brackets
 * @param tone - Visual tone for the badge (e.g., "accent", "primary", "success", "warning", "danger", "muted")
 * @returns The formatted badge string, styled when v2 is enabled, plain otherwise
 */
export function formatUiBadge(
	ui: UiRuntimeOptions,
	label: string,
	tone: Exclude<UiTextTone, "normal" | "heading"> = "accent",
): string {
	const text = `[${label}]`;
	if (!ui.v2Enabled) return text;
	const style = badgeStyleForTone(ui, tone);
	return `${style.start}${text}${style.end}`;
}

/**
 * Selects a severity tone ("success", "warning", or "danger") based on remaining percentage.
 *
 * @param leftPercent - Remaining percentage (expected in the 0–100 range); used to determine the severity bucket.
 * @returns `danger` if `leftPercent` is less than or equal to 15, `warning` if less than or equal to 35, `success` otherwise.
 *
 * Concurrency: pure and side-effect free. Windows filesystem: not applicable. Sensitive-token handling: none. */
export function quotaToneFromLeftPercent(
	leftPercent: number,
): Extract<UiTextTone, "success" | "warning" | "danger"> {
	if (leftPercent <= 15) return "danger";
	if (leftPercent <= 35) return "warning";
	return "success";
}
