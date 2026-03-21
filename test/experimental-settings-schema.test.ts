import { describe, expect, it } from "vitest";
import {
	getExperimentalSelectOptions,
	mapExperimentalMenuHotkey,
	mapExperimentalStatusHotkey,
} from "../lib/codex-manager/experimental-settings-schema.js";

describe("experimental settings schema", () => {
	it("builds select options from ui runtime state", () => {
		const options = getExperimentalSelectOptions(
			{ theme: { accent: "blue" } } as never,
			"Help text",
			() => undefined,
		);
		expect(options).toMatchObject({
			message: expect.any(String),
			subtitle: expect.any(String),
			help: "Help text",
			clearScreen: true,
			selectedEmphasis: "minimal",
		});
		expect(typeof options.onInput).toBe("function");
	});

	it("maps experimental menu hotkeys", () => {
		expect(mapExperimentalMenuHotkey("1")).toEqual({ type: "sync" });
		expect(mapExperimentalMenuHotkey("2")).toEqual({ type: "backup" });
		expect(mapExperimentalMenuHotkey("3")).toEqual({ type: "toggle-refresh-guardian" });
		expect(mapExperimentalMenuHotkey("[")).toEqual({ type: "decrease-refresh-interval" });
		expect(mapExperimentalMenuHotkey("]")).toEqual({ type: "increase-refresh-interval" });
		expect(mapExperimentalMenuHotkey("q")).toEqual({ type: "back" });
		expect(mapExperimentalMenuHotkey("s")).toEqual({ type: "save" });
		expect(mapExperimentalMenuHotkey("x")).toBeUndefined();
	});

	it("maps experimental status hotkeys", () => {
		expect(mapExperimentalStatusHotkey("q")).toEqual({ type: "back" });
		expect(mapExperimentalStatusHotkey("Q")).toEqual({ type: "back" });
		expect(mapExperimentalStatusHotkey("x")).toBeUndefined();
	});
});
