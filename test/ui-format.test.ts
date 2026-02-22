import { describe, it, expect } from "vitest";
import { createUiTheme } from "../lib/ui/theme.js";
import {
	formatUiBadge,
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
	formatUiSection,
	paintUiText,
} from "../lib/ui/format.js";
import type { UiRuntimeOptions } from "../lib/ui/runtime.js";

const v2Ui: UiRuntimeOptions = {
	v2Enabled: true,
	colorProfile: "truecolor",
	glyphMode: "ascii",
	theme: createUiTheme({ profile: "truecolor", glyphMode: "ascii" }),
};

const legacyUi: UiRuntimeOptions = {
	v2Enabled: false,
	colorProfile: "ansi16",
	glyphMode: "ascii",
	theme: createUiTheme({ profile: "ansi16", glyphMode: "ascii" }),
};

describe("UI text formatter", () => {
	it("returns plain text in legacy mode", () => {
		expect(paintUiText(legacyUi, "hello", "accent")).toBe("hello");
		expect(formatUiItem(legacyUi, "line")).toBe("- line");
		expect(formatUiKeyValue(legacyUi, "Key", "Value")).toBe("Key: Value");
	});

	it("returns styled text in v2 mode", () => {
		const text = paintUiText(v2Ui, "hello", "accent");
		expect(text).toContain("hello");
		expect(text).toContain("\x1b[");
	});

	it("formats codex-style headers and sections", () => {
		const header = formatUiHeader(v2Ui, "Codex accounts");
		expect(header).toHaveLength(2);
		expect(header[0]).toContain("Codex accounts");

		const section = formatUiSection(v2Ui, "Accounts");
		expect(section[0]).toContain("Accounts");
	});

	it("formats badges and list items", () => {
		const badge = formatUiBadge(v2Ui, "ok", "success");
		expect(badge).toContain("[ok]");

		const item = formatUiItem(v2Ui, "1. user@example.com");
		expect(item).toContain("1. user@example.com");
		expect(item).toContain(v2Ui.theme.glyphs.bullet);
	});
});

