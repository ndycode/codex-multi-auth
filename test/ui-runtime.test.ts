import { describe, it, expect, beforeEach } from "vitest";
import {
	getUiRuntimeOptions,
	resetUiRuntimeOptions,
	setUiRuntimeOptions,
} from "../lib/ui/runtime.js";

describe("UI runtime options", () => {
	beforeEach(() => {
		resetUiRuntimeOptions();
	});

	it("starts with codex v2 enabled by default", () => {
		const ui = getUiRuntimeOptions();
		expect(ui.v2Enabled).toBe(true);
		expect(ui.colorProfile).toBe("truecolor");
		expect(ui.glyphMode).toBe("ascii");
	});

	it("updates runtime options and rebuilds theme", () => {
		const updated = setUiRuntimeOptions({
			v2Enabled: false,
			colorProfile: "ansi16",
			glyphMode: "unicode",
		});

		expect(updated.v2Enabled).toBe(false);
		expect(updated.colorProfile).toBe("ansi16");
		expect(updated.glyphMode).toBe("unicode");
		expect(updated.theme.profile).toBe("ansi16");
		expect(updated.theme.glyphMode).toBe("unicode");
	});

	it("supports partial updates", () => {
		setUiRuntimeOptions({ v2Enabled: false });
		const ui = getUiRuntimeOptions();
		expect(ui.v2Enabled).toBe(false);
		expect(ui.colorProfile).toBe("truecolor");
		expect(ui.glyphMode).toBe("ascii");
	});
});

