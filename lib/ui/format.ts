import type { UiRuntimeOptions } from "./runtime.js";

export type UiTextTone =
	| "heading"
	| "accent"
	| "muted"
	| "success"
	| "warning"
	| "danger"
	| "normal";

const TONE_TO_COLOR: Record<UiTextTone, keyof UiRuntimeOptions["theme"]["colors"] | null> = {
	heading: "heading",
	accent: "accent",
	muted: "muted",
	success: "success",
	warning: "warning",
	danger: "danger",
	normal: null,
};

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

export function formatUiBadge(
	ui: UiRuntimeOptions,
	label: string,
	tone: Exclude<UiTextTone, "normal" | "heading"> = "accent",
): string {
	const text = `[${label}]`;
	return paintUiText(ui, text, tone);
}

